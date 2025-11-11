// db-helpers.js
const supabase = require('./supabase-client');

async function getSetting(key) {
  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', key)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data ? data.value : null;
}

async function setSetting(key, value) {
  await supabase
    .from('settings')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
}

async function ensureStaff(discordId, displayName = null) {
  const { data, error } = await supabase
    .from('staff')
    .select('discord_id, display_name')
    .eq('discord_id', discordId)
    .limit(1)
    .single();

  if (error && error.code !== 'PGRST116') throw error;

  if (!data) {
    const payload = { discord_id: discordId };
    if (displayName) payload.display_name = displayName;
    await supabase.from('staff').insert(payload);
    return;
  }

  if (displayName) {
    const current = data.display_name;
    const isPlaceholder = !current || /^staff\d*$/i.test(String(current).trim());
    if (isPlaceholder) {
      await supabase
        .from('staff')
        .update({ display_name: displayName, updated_at: new Date().toISOString() })
        .eq('discord_id', discordId);
    }
  }
}

async function incrementMessageCount(discordId, channelId) {
  await ensureStaff(discordId);
  try {
    await supabase.rpc('increment_staff_messages', { p_discord_id: discordId });
  } catch {
    const { data } = await supabase
      .from('staff')
      .select('messages_count')
      .eq('discord_id', discordId)
      .single();
    const cur = Number((data && data.messages_count) || 0);
    await supabase
      .from('staff')
      .update({
        messages_count: cur + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('discord_id', discordId);
  }

  await supabase
    .from('message_logs')
    .insert({ discord_id: discordId, channel_id: channelId })
    .catch(() => {});
  await recomputePoints(discordId);
}

async function recomputePoints(discordId) {
  const { data } = await supabase
    .from('staff')
    .select('messages_count, minutes_on_stage')
    .eq('discord_id', discordId)
    .single();
  if (!data) return;
  const pts = (data.messages_count / 100) + (data.minutes_on_stage / 30);
  await supabase
    .from('staff')
    .update({ points: pts.toFixed(4), updated_at: new Date().toISOString() })
    .eq('discord_id', discordId);
}

async function startStageSession(discordId) {
  await ensureStaff(discordId);
  await supabase
    .from('stage_sessions')
    .insert({ discord_id: discordId, start_at: new Date().toISOString() });
}

async function endStageSession(discordId) {
  const { data } = await supabase
    .from('stage_sessions')
    .select('*')
    .eq('discord_id', discordId)
    .is('end_at', null)
    .order('start_at', { ascending: false })
    .limit(1)
    .single();

  if (!data) return;
  const mins = Math.floor((Date.now() - new Date(data.start_at)) / 60000);
  await supabase.from('stage_sessions').update({ end_at: new Date().toISOString() }).eq('id', data.id);
  try {
    await supabase.rpc('increment_minutes_on_stage', {
      p_discord_id: discordId,
      p_minutes: mins,
    });
  } catch {
    const { data: s } = await supabase
      .from('staff')
      .select('minutes_on_stage')
      .eq('discord_id', discordId)
      .single();
    const cur = Number((s && s.minutes_on_stage) || 0);
    await supabase
      .from('staff')
      .update({ minutes_on_stage: cur + mins, updated_at: new Date().toISOString() })
      .eq('discord_id', discordId);
  }
  await recomputePoints(discordId);
}

async function getLeaderboard(limit = 15) {
  const { data } = await supabase
    .from('staff')
    .select('discord_id, display_name, points, messages_count, minutes_on_stage')
    .order('points', { ascending: false })
    .limit(limit);
  return data || [];
}

module.exports = {
  getSetting,
  setSetting,
  ensureStaff,
  incrementMessageCount,
  recomputePoints,
  startStageSession,
  endStageSession,
  getLeaderboard,
};
