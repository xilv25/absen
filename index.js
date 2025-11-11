// index.js
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

if (!SUPABASE_URL || !SUPABASE_KEY || !DISCORD_TOKEN) {
  console.error('Missing env vars. Set SUPABASE_URL, SUPABASE_KEY, DISCORD_TOKEN.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// Config from env (IDs as string). For multiple channels list comma-separated.
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID || ''; // role ID for staff
const STAGE_MOD_ID = process.env.STAGE_MOD_ID || '';   // user ID of the stage moderator
const MONITORED_CHANNEL_IDS = (process.env.MONITORED_CHANNEL_IDS || '').split(',').filter(Boolean); // channel IDs to count messages
const STAFF_CHANNEL_ID = process.env.STAFF_CHANNEL_ID || ''; // where control buttons are posted
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID || ''; // where to post/edit leaderboard

// helper: ensure staff row
async function ensureStaff(discordId, displayName = null) {
  const { data, error } = await supabase
    .from('staff')
    .select('discord_id')
    .eq('discord_id', discordId)
    .limit(1);

  if (error) throw error;
  if (!data || data.length === 0) {
    const payload = { discord_id: discordId, display_name: displayName || null };
    await supabase.from('staff').insert(payload);
  }
}

// increment messages_count by 1 (non-atomic simple version)
async function incrementMessageCount(discordId, channelId) {
  await ensureStaff(discordId);
  // read current
  const { data: sdata, error: rerr } = await supabase.from('staff').select('messages_count').eq('discord_id', discordId).single();
  if (rerr) throw rerr;
  const cur = Number((sdata && sdata.messages_count) || 0);
  const next = cur + 1;
  const { error: uerr } = await supabase.from('staff').update({ messages_count: next, updated_at: new Date().toISOString() }).eq('discord_id', discordId);
  if (uerr) throw uerr;

  // optional log
  await supabase.from('message_logs').insert({ discord_id: discordId, channel_id: channelId }).catch(() => {});
  await recomputePoints(discordId);
}

// recompute points from messages & minutes
async function recomputePoints(discordId) {
  const { data, error } = await supabase.from('staff').select('messages_count, minutes_on_stage').eq('discord_id', discordId).single();
  if (error) throw error;
  const msgs = Number((data && data.messages_count) || 0);
  const mins = Number((data && data.minutes_on_stage) || 0);
  const pointsFromMsgs = msgs / 100.0; // 100 msgs = 1 point
  const pointsFromStage = mins / 30.0; // 30 min = 1 point
  const total = Number((pointsFromMsgs + pointsFromStage).toFixed(4));
  await supabase.from('staff').update({ points: total, updated_at: new Date().toISOString() }).eq('discord_id', discordId);
}

// stage session handling
async function startStageSession(discordId) {
  await ensureStaff(discordId);
  await supabase.from('stage_sessions').insert({ discord_id: discordId, start_at: new Date().toISOString() });
}

async function endStageSession(discordId) {
  // find last open session
  const { data: sessions, error: sErr } = await supabase
    .from('stage_sessions')
    .select('*')
    .eq('discord_id', discordId)
    .is('end_at', null)
    .order('start_at', { ascending: false })
    .limit(1);

  if (sErr) throw sErr;
  if (!sessions || sessions.length === 0) return;
  const sess = sessions[0];
  const start = new Date(sess.start_at);
  const end = new Date();
  const minutes = Math.floor((end - start) / 60000);

  await supabase.from('stage_sessions').update({ end_at: end.toISOString() }).eq('id', sess.id);
  // add minutes to staff
  const { data: cur, error: r } = await supabase.from('staff').select('minutes_on_stage').eq('discord_id', discordId).single();
  if (r) throw r;
  const curMin = Number((cur && cur.minutes_on_stage) || 0);
  await supabase.from('staff').update({ minutes_on_stage: curMin + minutes, updated_at: new Date().toISOString() }).eq('discord_id', discordId);
  await recomputePoints(discordId);
}

// get leaderboard
async function getLeaderboard(limit = 13) {
  const { data, error } = await supabase.from('staff').select('discord_id,display_name,points,messages_count,minutes_on_stage').order('points', { ascending: false }).limit(limit);
  if (error) throw error;
  return data || [];
}

// update or send leaderboard embed in configured channel
async function postOrUpdateLeaderboard(client) {
  if (!LEADERBOARD_CHANNEL_ID) return;
  try {
    const ch = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
    const rows = await getLeaderboard(13);
    const desc = rows.map((r, i) => {
      const nameOrId = r.display_name ? `${r.display_name}` : `<@${r.discord_id}>`;
      const pts = Number(r.points || 0).toFixed(2);
      return `**${i+1}.** ${nameOrId} — ${pts} pts (msgs:${r.messages_count||0}, mins:${r.minutes_on_stage||0})`;
    }).join('\n') || 'Belum ada data.';
    const embed = new EmbedBuilder().setTitle('Leaderboard Staff').setDescription(desc).setTimestamp();

    // try find existing bot message in channel with this embed title
    const fetch = await ch.messages.fetch({ limit: 50 });
    const botMsg = fetch.find(m => m.author?.id === client.user.id && m.embeds?.[0]?.title === 'Leaderboard Staff');

    if (botMsg) {
      await botMsg.edit({ embeds: [embed] });
    } else {
      await ch.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error('Failed post/update leaderboard', err.message || err);
  }
}

// create staff control buttons (post once in STAFF_CHANNEL_ID)
async function sendStaffControls(client) {
  if (!STAFF_CHANNEL_ID) return;
  try {
    const ch = await client.channels.fetch(STAFF_CHANNEL_ID);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('absen').setLabel('Absen').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ijin').setLabel('Ijin').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('lanjut').setLabel('Lanjut').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('off').setLabel('Off').setStyle(ButtonStyle.Danger),
    );
    // Send ephemeral instruction and buttons
    await ch.send({ content: 'Tombol kontrol kehadiran staff — klik sesuai kebutuhan.', components: [row] });
  } catch (err) {
    console.error('sendStaffControls err', err.message || err);
  }
}

// discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel]
});

// interaction (button) handler
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  const uid = interaction.user.id;

  // only staff can press (check role)
  try {
    const member = interaction.member;
    if (!member) return interaction.reply({ content: 'Member data missing.', ephemeral: true });
    if (STAFF_ROLE_ID && !member.roles.cache.has(STAFF_ROLE_ID)) {
      return interaction.reply({ content: 'Hanya staff yang bisa mengubah status.', ephemeral: true });
    }
  } catch (err) {
    console.error('role check', err);
  }

  await ensureStaff(uid, interaction.user.username);

  if (interaction.customId === 'absen') {
    await supabase.from('staff').update({ status: 'active', updated_at: new Date().toISOString() }).eq('discord_id', uid);
    await interaction.reply({ content: 'Kamu sekarang **absen (aktif)**. Counting dimulai.', ephemeral: true });
  } else if (interaction.customId === 'ijin') {
    await supabase.from('staff').update({ status: 'paused', updated_at: new Date().toISOString() }).eq('discord_id', uid);
    await interaction.reply({ content: 'Kamu **ijin**. Counting dihentikan sementara.', ephemeral: true });
  } else if (interaction.customId === 'lanjut') {
    await supabase.from('staff').update({ status: 'active', updated_at: new Date().toISOString() }).eq('discord_id', uid);
    await interaction.reply({ content: 'Counting dilanjutkan.', ephemeral: true });
  } else if (interaction.customId === 'off') {
    await supabase.from('staff').update({ status: 'off', updated_at: new Date().toISOString() }).eq('discord_id', uid);
    await interaction.reply({ content: 'Kamu **off**. Counting berhenti.', ephemeral: true });
  }
});

// message counting
client.on('messageCreate', async (msg) => {
  try {
    if (msg.author?.bot) return;
    if (!MONITORED_CHANNEL_IDS.includes(msg.channel.id)) return;
    const member = msg.member;
    if (!member) return;
    if (STAFF_ROLE_ID && !member.roles.cache.has(STAFF_ROLE_ID)) return;
    // check staff status
    const { data: row, error: e } = await supabase.from('staff').select('status').eq('discord_id', member.id).single();
    if (e && e.code !== 'PGRST116') { /* ignore if no row */ }
    const status = (row && row.status) || 'off';
    if (status !== 'active') return;
    await incrementMessageCount(member.id, msg.channel.id);
  } catch (err) {
    console.error('messageCreate handler error', err.message || err);
  }
});

// voiceStateUpdate -> track stage mod join/leave
client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    const oldCh = oldState.channel;
    const newCh = newState.channel;
    const userId = (newState.member || oldState.member)?.id;

    if (!STAGE_MOD_ID) return;

    // joined stage
    if (newCh && userId === STAGE_MOD_ID && newCh?.type === 13 /* GUILD_STAGE_VOICE */) {
      await startStageSession(STAGE_MOD_ID);
    }

    // left stage
    if (oldCh && userId === STAGE_MOD_ID && oldCh?.type === 13 && (!newCh || newCh.id !== oldCh.id)) {
      await endStageSession(STAGE_MOD_ID);
    }
  } catch (err) {
    console.error('voiceStateUpdate error', err.message || err);
  }
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // ensure tables exist? assume created in Supabase already.
  // send control panel if desired (uncomment to send automatically)
  // await sendStaffControls(client);

  // initial leaderboard post/update
  await postOrUpdateLeaderboard(client);

  // update leaderboard every 30s
  setInterval(() => postOrUpdateLeaderboard(client).catch(console.error), 30_000);
});

// login
client.login(DISCORD_TOKEN).catch(err => {
  console.error('login failed', err);
  process.exit(1);
});
