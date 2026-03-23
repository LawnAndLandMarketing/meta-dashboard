/**
 * L&L Meta Ads — Kai Review Endpoint
 * Called by cron at 8 AM and 1 PM ET daily.
 * Scans all accounts, writes structured review to GitHub, sends Telegram alert if needed.
 * Also handles GET requests to fetch the latest review for the dashboard sidebar.
 */

const META_TOKEN = process.env.META_SYSTEM_USER_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const BASE = 'https://graph.facebook.com/v21.0';
const REPO = 'LawnAndLandMarketing/ll-meta-dashboard';
const REVIEW_FILE = 'data/reviews.json';

async function fetchGraph(path, params = {}) {
  const qs = new URLSearchParams({ access_token: META_TOKEN, ...params });
  const res = await fetch(`${BASE}/${path}?${qs}`);
  return res.json();
}

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' }),
  });
}

async function getReviews() {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${REVIEW_FILE}`,
    { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
  );
  const data = await res.json();
  const content = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
  return { data: content, sha: data.sha };
}

async function saveReview(review, existingSha) {
  const reviews = await getReviews();
  const current = reviews.data;
  current.reviews.unshift(review);
  if (current.reviews.length > 14) current.reviews = current.reviews.slice(0, 14); // keep 7 days (2/day)
  current.lastUpdated = review.reviewedAt;

  const encoded = Buffer.from(JSON.stringify(current, null, 2)).toString('base64');
  await fetch(
    `https://api.github.com/repos/${REPO}/contents/${REVIEW_FILE}`,
    {
      method: 'PUT',
      headers: { Authorization: `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Kai review — ${review.session}`,
        content: encoded,
        sha: reviews.sha,
      }),
    }
  );
}

const STATUS_MAP = { 1: 'active', 2: 'disabled', 3: 'restricted', 7: 'pending_review' };
const AWARENESS_OBJECTIVES = new Set(['OUTCOME_AWARENESS', 'REACH', 'VIDEO_VIEWS', 'BRAND_AWARENESS', 'PAGE_LIKES']);
const LEADS_OBJECTIVES = new Set(['OUTCOME_LEADS', 'LEAD_GENERATION', 'CONVERSIONS', 'OUTCOME_SALES']);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // GET — return latest reviews for dashboard sidebar
  if (req.method === 'GET') {
    try {
      const { data } = await getReviews();
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // POST — run review (called by cron)
  if (!META_TOKEN) return res.status(500).json({ error: 'META_SYSTEM_USER_TOKEN not configured' });

  const session = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true, hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
  const isMorning = new Date().getUTCHours() < 14; // before 2 PM UTC = morning ET

  try {
    const accountsData = await fetchGraph('me/adaccounts', {
      fields: 'id,name,account_status,disable_reason,funding_source_details,amount_spent',
      limit: 100,
    });
    const accounts = accountsData?.data || [];

    const critical = [];
    const warnings = [];
    const healthy = [];
    let totalSpendToday = 0;
    let totalLeadsToday = 0;

    for (const acct of accounts) {
      const acctFlags = [];
      const acctName = acct.name;

      // Account status
      if (acct.account_status !== 1) {
        const label = STATUS_MAP[acct.account_status] || 'offline';
        acctFlags.push({ type: 'error', code: 'ACCOUNT_RESTRICTED', msg: `Account ${label.toUpperCase()}` });
      }

      if (acct.account_status === 1) {
        // Payment check
        if (!acct.funding_source_details?.id) {
          acctFlags.push({ type: 'error', code: 'NO_PAYMENT', msg: 'No payment method on file' });
        }

        // Get active campaigns + today's insights
        const [campaignsData, insightsData, adsData] = await Promise.all([
          fetchGraph(`${acct.id}/campaigns`, {
            fields: 'id,name,objective,effective_status',
            filtering: JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE'] }]),
            limit: 20,
          }),
          fetchGraph(`${acct.id}/insights`, {
            fields: 'spend,actions,cost_per_action_type',
            date_preset: 'today',
          }),
          fetchGraph(`${acct.id}/ads`, {
            fields: 'id,name,effective_status',
            filtering: JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['DISAPPROVED', 'WITH_ISSUES'] }]),
            limit: 5,
          }),
        ]);

        const campaigns = campaignsData?.data || [];
        const d = insightsData?.data?.[0] || {};
        const spend = parseFloat(d.spend || 0);
        const leads = parseInt(d.actions?.find(a => a.action_type === 'lead')?.value || 0);
        const cpl = parseFloat(d.cost_per_action_type?.find(a => a.action_type === 'lead')?.value || 0);
        const badAds = adsData?.data?.length || 0;

        totalSpendToday += spend;
        totalLeadsToday += leads;

        // Determine campaign type
        let hasLeads = campaigns.some(c => LEADS_OBJECTIVES.has(c.objective));
        let hasAwareness = campaigns.some(c => AWARENESS_OBJECTIVES.has(c.objective));

        // Policy violations
        if (badAds > 0) {
          acctFlags.push({ type: 'warning', code: 'POLICY', msg: `${badAds} ad${badAds > 1 ? 's' : ''} disapproved or with issues` });
        }

        // Spend but no leads (leads accounts only, weekdays)
        if (hasLeads && spend > 15 && leads === 0) {
          acctFlags.push({ type: 'warning', code: 'SPEND_NO_LEADS', msg: `$${spend.toFixed(0)} spent, 0 leads today` });
        }

        // CPL spike vs 7d avg
        if (hasLeads && cpl > 0) {
          const ins7 = await fetchGraph(`${acct.id}/insights`, { fields: 'spend,actions', date_preset: 'last_7d' });
          const d7 = ins7?.data?.[0];
          if (d7) {
            const spend7 = parseFloat(d7.spend || 0);
            const leads7 = parseInt(d7.actions?.find(a => a.action_type === 'lead')?.value || 0);
            const avgCpl = leads7 > 0 ? spend7 / leads7 : 0;
            if (avgCpl > 0 && cpl > avgCpl * 2.5) {
              acctFlags.push({ type: 'warning', code: 'CPL_SPIKE', msg: `CPL today $${cpl.toFixed(0)} vs $${avgCpl.toFixed(0)} avg (${Math.round(cpl / avgCpl)}x spike)` });
            }
          }
        }

        // No active campaigns on active account
        if (campaigns.length === 0 && spend === 0) {
          acctFlags.push({ type: 'info', code: 'NO_CAMPAIGNS', msg: 'No active campaigns' });
        }

        if (acctFlags.length === 0) {
          healthy.push({ name: acctName, spend, leads, cpl });
        } else if (acctFlags.some(f => f.type === 'error')) {
          critical.push({ name: acctName, flags: acctFlags, spend, leads });
        } else {
          warnings.push({ name: acctName, flags: acctFlags, spend, leads });
        }
      } else {
        critical.push({ name: acctName, flags: acctFlags, spend: 0, leads: 0 });
      }
    }

    // Build plain-English summary
    let summary = '';
    if (critical.length === 0 && warnings.length === 0) {
      summary = `All clear. ${healthy.length} accounts running clean. Portfolio spent $${totalSpendToday.toFixed(0)} today with ${totalLeadsToday} leads.`;
    } else {
      const parts = [];
      if (critical.length > 0) parts.push(`${critical.length} critical issue${critical.length > 1 ? 's' : ''}`);
      if (warnings.length > 0) parts.push(`${warnings.length} warning${warnings.length > 1 ? 's' : ''}`);
      summary = `${parts.join(' and ')} across the portfolio. ${healthy.length} accounts clean. $${totalSpendToday.toFixed(0)} spent today, ${totalLeadsToday} leads.`;
    }

    const review = {
      session,
      reviewedAt: new Date().toISOString(),
      timeOfDay: isMorning ? 'morning' : 'midday',
      summary,
      stats: {
        total: accounts.length,
        critical: critical.length,
        warnings: warnings.length,
        healthy: healthy.length,
        spendToday: totalSpendToday,
        leadsToday: totalLeadsToday,
      },
      critical,
      warnings,
      topPerformers: healthy
        .filter(a => a.leads > 0)
        .sort((a, b) => a.cpl - b.cpl)
        .slice(0, 3)
        .map(a => ({ name: a.name, cpl: a.cpl, leads: a.leads })),
    };

    // Save to GitHub
    await saveReview(review);

    // Send Telegram alert if issues exist
    if (critical.length > 0 || warnings.length > 0) {
      const time = isMorning ? '8:00 AM' : '1:00 PM';
      let msg = `🔍 <b>Kai's Meta Review</b> — ${time} ET\n<i>${summary}</i>\n`;

      if (critical.length > 0) {
        msg += `\n🔴 <b>Critical (${critical.length})</b>\n`;
        for (const a of critical) {
          msg += `\n<b>${a.name}</b>\n`;
          for (const f of a.flags) msg += `  • ${f.msg}\n`;
        }
      }
      if (warnings.length > 0) {
        msg += `\n⚠️ <b>Warnings (${warnings.length})</b>\n`;
        for (const a of warnings.slice(0, 5)) {
          msg += `\n<b>${a.name}</b>\n`;
          for (const f of a.flags) msg += `  • ${f.msg}\n`;
        }
        if (warnings.length > 5) msg += `\n<i>...and ${warnings.length - 5} more</i>\n`;
      }

      msg += `\n👉 <a href="https://meta.groundcontrol.agency">View Dashboard →</a>`;
      await sendTelegram(msg);
    }

    return res.status(200).json({ ok: true, summary, critical: critical.length, warnings: warnings.length, healthy: healthy.length });

  } catch (err) {
    console.error('Kai review error:', err);
    return res.status(500).json({ error: err.message });
  }
}
