// db-helpers.js
const supabase = require('./supabase-client');

async function getSetting(key) {
  const { data, error } = await supabase.from('settings').select('value').eq('key', key).single();
  if (error && error.code !== 'PGRST116') throw error;
  return data ? data.value : null;
}

async function setSetting(key, value) {
  const { error } = await supabase.from('settings').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
}

async function ensureStaff(discordId, displayName = null) {
  const { data, error } = await supabase.from('staff').select('discord_id').eq('discord_id', discordId).limit(1);
  if (error) throw error;
  if (!data || data.length === 0) {
    await supabase.from('staff').insert({ discord_id: discordId, display_name: displayName || null });
  }
}

async function incrementMessageCount(discordId, channelId) {
  await ensureStaff(discordId);
  // try RPC (atomic)
  try {
    await supabase.rpc('increment_staff_messages', { p_discord_id: discordId });
  } catch (err) {
    // fallback: read-update
    const { data } = await supabase.from('staff').select('messages_count').eq('discord_id', discordId).single();
    const cur = Number((data && data.messages_count) || 0);
    await supabase.from('staff').update({ messages_count: cur + 1, updated_at: new Date().toISOString() }).eq('discord_id', discordId);
  }
  // log
  await supabase.from('message_logs').insert({ discord_id: discordId, channel_id: channelId }).catch(()=>{});
  // recompute points if trigger not present (trigger exists in SQL above so likely not needed)
  await recomputePoints(discordId);
}

async function recomputePoints(discordId) {
  // If trigger exists this is redundant, but safe to run
  const { data, error } = await supabase.from('staff').select('messages_count, minutes_on_stage').eq('discord_id', discordId).single();
  if (error) return;
  const msgs = Number(data.messages_count || 0);
  const mins = Number(data.minutes_on_stage || 0);
  const total = Number(((msgs / 100.0) + (mins / 30.0)).toFixed(4));
  await supabase.from('staff').update({ points: total, updated_at: new Date().toISOString() }).eq('discord_id', discordId);
}

async function startStageSession(discordId) {
  await ensureStaff(discordId);
  await supabase.from('stage_sessions').insert({ discord_id: discordId, start_at: new Date().toISOString() });
}

async function endStageSession(discordId) {
  const { data, error } = await supabase
    .from('stage_sessions')
    .select('*')
    .eq('discord_id', discordId)
    .is('end_at', null)
    .order('start_at', { ascending: false })
    .limit(1)
    .single();
  if (!data) return;
  const start = new Date(data.start_at);
  const end = new Date();
  const minutes = Math.floor((end - start) / 60000);
  await supabase.from('stage_sessions').update({ end_at: end.toISOString() }).eq('id', data.id);
  // add minutes
  await supabase.rpc('increment_minutes_on_stage', { p_discord_id: discordId, p_minutes: minutes })
    .catch(async ()=> {
      // fallback
      const { data: s } = await supabase.from('staff').select('minutes_on_stage').eq('discord_id', discordId).single();
      const cur = Number((s && s.minutes_on_stage) || 0);
      await supabase.from('staff').update({ minutes_on_stage: cur + minutes, updated_at: new Date().toISOString() }).eq('discord_id', discordId);
    });
  await recomputePoints(discordId);
}

async function getLeaderboard(limit = 13) {
  const { data, error } = await supabase.from('staff')
    .select('discord_id,display_name,points,messages_count,minutes_on_stage')
    .order('points', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

module.exports = {
  getSetting, setSetting, ensureStaff, incrementMessageCount, recomputePoints, startStageSession, endStageSession, getLeaderboard
};
