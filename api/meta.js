/**
 * L&L Meta Ads API — Serverless Edge Function
 * Fetches all client ad account data from Meta Graph API
 * Deployed via Vercel serverless functions
 */

const META_TOKEN = process.env.META_SYSTEM_USER_TOKEN;
const BASE = 'https://graph.facebook.com/v21.0';

const STATUS_MAP = {
  1: 'active',
  2: 'disabled',
  3: 'restricted',
  7: 'pending_review',
  8: 'personal_disabled',
  9: 'warmup',
};

const DISABLE_REASON_MAP = {
  0: null,
  1: 'ADS_INTEGRITY_POLICY',
  2: 'ADS_IP_REVIEW',
  3: 'RISK_PAYMENT',
  4: 'GRAY_ACCOUNT_SHUT_DOWN',
  5: 'ADS_AFC_REVIEW',
  6: 'BUSINESS_INTEGRITY_RAC',
  7: 'PERMANENT_CLOSE',
  8: 'UNUSED_RESELLER_ACCOUNT',
  9: 'UNUSED_ACCOUNT',
};

async function fetchGraph(path, params = {}) {
  const qs = new URLSearchParams({ access_token: META_TOKEN, ...params });
  const res = await fetch(`${BASE}/${path}?${qs}`);
  if (!res.ok) throw new Error(`Meta API error: ${res.status}`);
  return res.json();
}

async function getAccountInsights(accountId, datePreset = 'today') {
  try {
    const data = await fetchGraph(`${accountId}/insights`, {
      fields: 'spend,impressions,clicks,ctr,cpm,actions,cost_per_action_type',
      date_preset: datePreset,
      level: 'account',
    });
    const d = data?.data?.[0] || {};
    const leads = d.actions?.find(a => a.action_type === 'lead')?.value || 0;
    const cpl = d.cost_per_action_type?.find(a => a.action_type === 'lead')?.value || 0;
    return {
      spend: parseFloat(d.spend || 0),
      impressions: parseInt(d.impressions || 0),
      clicks: parseInt(d.clicks || 0),
      ctr: parseFloat(d.ctr || 0),
      cpm: parseFloat(d.cpm || 0),
      leads: parseInt(leads),
      cpl: parseFloat(cpl),
    };
  } catch {
    return { spend: 0, impressions: 0, clicks: 0, ctr: 0, cpm: 0, leads: 0, cpl: 0 };
  }
}

async function getActiveCampaigns(accountId) {
  try {
    const data = await fetchGraph(`${accountId}/campaigns`, {
      fields: 'id,name,status,effective_status,daily_budget,objective',
      filtering: JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE'] }]),
      limit: 20,
    });
    return data?.data || [];
  } catch {
    return [];
  }
}

function detectCampaignType(campaigns) {
  if (!campaigns.length) return 'unknown';
  const AWARENESS_OBJECTIVES = ['OUTCOME_AWARENESS', 'REACH', 'VIDEO_VIEWS', 'BRAND_AWARENESS', 'PAGE_LIKES'];
  const LEADS_OBJECTIVES = ['OUTCOME_LEADS', 'LEAD_GENERATION', 'CONVERSIONS', 'OUTCOME_SALES'];
  let hasLeads = false;
  let hasAwareness = false;
  for (const c of campaigns) {
    if (LEADS_OBJECTIVES.includes(c.objective)) hasLeads = true;
    if (AWARENESS_OBJECTIVES.includes(c.objective)) hasAwareness = true;
  }
  if (hasLeads && hasAwareness) return 'mixed';
  if (hasLeads) return 'leads';
  if (hasAwareness) return 'awareness';
  return 'other';
}

async function getAwarenessInsights(accountId, datePreset = 'today') {
  try {
    const data = await fetchGraph(`${accountId}/insights`, {
      fields: 'spend,impressions,reach,cpm,video_play_actions',
      date_preset: datePreset,
      level: 'account',
    });
    const d = data?.data?.[0] || {};
    const videoViews = d.video_play_actions?.find(a => a.action_type === 'video_view')?.value || 0;
    return {
      spend: parseFloat(d.spend || 0),
      impressions: parseInt(d.impressions || 0),
      reach: parseInt(d.reach || 0),
      cpm: parseFloat(d.cpm || 0),
      videoViews: parseInt(videoViews),
    };
  } catch {
    return { spend: 0, impressions: 0, reach: 0, cpm: 0, videoViews: 0 };
  }
}

async function getPolicyIssues(accountId) {
  try {
    const data = await fetchGraph(`${accountId}/ads`, {
      fields: 'id,name,effective_status,review_feedback',
      filtering: JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['DISAPPROVED', 'WITH_ISSUES'] }]),
      limit: 10,
    });
    return data?.data || [];
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  if (!META_TOKEN) {
    return res.status(500).json({ error: 'META_SYSTEM_USER_TOKEN not configured' });
  }

  try {
    // Fetch all accounts
    const accountsData = await fetchGraph('me/adaccounts', {
      fields: 'id,name,account_status,disable_reason,currency,amount_spent,spend_cap,funding_source_details',
      limit: 100,
    });

    const accounts = accountsData?.data || [];

    // Parallel fetch insights for all accounts
    const enriched = await Promise.all(
      accounts.map(async (acct) => {
        const isActive = acct.account_status === 1;

        const [todayInsights, mtdInsights, last7Insights, todayAwareness, mtdAwareness, campaigns, policyIssues] = await Promise.all([
          isActive ? getAccountInsights(acct.id, 'today') : Promise.resolve(null),
          isActive ? getAccountInsights(acct.id, 'this_month') : Promise.resolve(null),
          isActive ? getAccountInsights(acct.id, 'last_7d') : Promise.resolve(null),
          isActive ? getAwarenessInsights(acct.id, 'today') : Promise.resolve(null),
          isActive ? getAwarenessInsights(acct.id, 'this_month') : Promise.resolve(null),
          isActive ? getActiveCampaigns(acct.id) : Promise.resolve([]),
          isActive ? getPolicyIssues(acct.id) : Promise.resolve([]),
        ]);

        const campaignType = detectCampaignType(campaigns);

        // Compute health flags
        const flags = [];
        if (acct.account_status !== 1) {
          flags.push({
            type: 'error',
            code: 'ACCOUNT_RESTRICTED',
            message: `Account ${STATUS_MAP[acct.account_status] || 'disabled'}: ${DISABLE_REASON_MAP[acct.disable_reason] || 'Unknown reason'}`,
          });
        }
        if (policyIssues.length > 0) {
          flags.push({
            type: 'warning',
            code: 'POLICY_ISSUES',
            message: `${policyIssues.length} ad(s) disapproved or with issues`,
          });
        }
        if (isActive && todayInsights?.spend > 0 && todayInsights?.leads === 0 && todayInsights?.spend > 20) {
          flags.push({
            type: 'warning',
            code: 'SPEND_NO_LEADS',
            message: `$${todayInsights.spend.toFixed(2)} spent today with 0 leads`,
          });
        }
        // CPL spike: today vs 7-day avg
        const avg7dCpl = last7Insights?.leads > 0 ? (last7Insights.spend / last7Insights.leads) : 0;
        if (todayInsights?.cpl > 0 && avg7dCpl > 0 && todayInsights.cpl > avg7dCpl * 2) {
          flags.push({
            type: 'warning',
            code: 'CPL_SPIKE',
            message: `CPL today $${todayInsights.cpl.toFixed(0)} vs 7-day avg $${avg7dCpl.toFixed(0)} (${Math.round(todayInsights.cpl / avg7dCpl)}x)`,
          });
        }

        const health = flags.some(f => f.type === 'error') ? 'critical'
          : flags.some(f => f.type === 'warning') ? 'warning'
          : isActive ? 'healthy'
          : 'inactive';

        return {
          id: acct.id,
          name: acct.name,
          status: STATUS_MAP[acct.account_status] || 'unknown',
          accountStatus: acct.account_status,
          disableReason: DISABLE_REASON_MAP[acct.disable_reason] || null,
          currency: acct.currency || 'USD',
          lifetimeSpend: parseFloat(acct.amount_spent || 0) / 100,
          hasPaymentMethod: !!acct.funding_source_details?.id,
          campaignType,
          today: todayInsights,
          mtd: mtdInsights,
          last7d: last7Insights,
          todayAwareness,
          mtdAwareness,
          activeCampaigns: campaigns.length,
          campaignNames: campaigns.map(c => c.name).slice(0, 3),
          policyIssues: policyIssues.length,
          flags,
          health,
        };
      })
    );

    // Sort: critical first, then warning, then healthy, then inactive
    const order = { critical: 0, warning: 1, healthy: 2, inactive: 3 };
    enriched.sort((a, b) => (order[a.health] ?? 4) - (order[b.health] ?? 4));

    const summary = {
      total: enriched.length,
      critical: enriched.filter(a => a.health === 'critical').length,
      warning: enriched.filter(a => a.health === 'warning').length,
      healthy: enriched.filter(a => a.health === 'healthy').length,
      inactive: enriched.filter(a => a.health === 'inactive').length,
      totalSpendToday: enriched.reduce((s, a) => s + (a.today?.spend || 0), 0),
      totalSpendMtd: enriched.reduce((s, a) => s + (a.mtd?.spend || 0), 0),
      totalLeadsToday: enriched.reduce((s, a) => s + (a.today?.leads || 0), 0),
      totalLeadsMtd: enriched.reduce((s, a) => s + (a.mtd?.leads || 0), 0),
    };

    return res.status(200).json({
      summary,
      accounts: enriched,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Meta API error:', err);
    return res.status(500).json({ error: err.message });
  }
}
