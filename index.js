// index.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Partials, Collection, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const supabase = require('./supabase-client');
const db = require('./db-helpers');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) throw new Error('DISCORD_TOKEN missing');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

// load commands
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
if (fs.existsSync(commandsPath)) {
  const files = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const cmd = require(path.join(commandsPath, f));
    client.commands.set(cmd.data.name, cmd);
  }
}

// helper: build and post/update single panel message
async function postOrUpdatePanel() {
  try {
    const staffChannel = await db.getSetting('staff_channel');
    const panelChannelId = staffChannel || await db.getSetting('leaderboard_channel');
    if (!panelChannelId) return;

    const ch = await client.channels.fetch(panelChannelId).catch(()=>null);
    if (!ch) return;

    const rows = await db.getLeaderboard(50);
    const desc = rows.map((r,i) => {
      const n = r.display_name || `<@${r.discord_id}>`;
      const pts = Number(r.points||0).toFixed(2);
      return `**${i+1}.** ${n} — ${pts} pts (msgs:${r.messages_count||0}, mins:${r.minutes_on_stage||0})`;
    }).join('\n') || 'Belum ada data.';

    const { data: allStaff } = await supabase.from('staff').select('discord_id, status, display_name').order('display_name', { ascending: true });

    const statusText = (allStaff || []).map(s => {
      const emoji = s.status === 'active' ? '🟢' : (s.status === 'paused' ? '🟠' : '⚪');
      const name = s.display_name || `<@${s.discord_id}>`;
      return `${emoji} ${name} — ${s.status}`;
    }).join('\n') || 'No staff registered.';

    const embed = new EmbedBuilder()
      .setTitle('Panel Absen & Leaderboard Staff')
      .addFields(
        { name: 'Leaderboard', value: desc, inline: false },
        { name: 'Status Staff', value: statusText, inline: false }
      )
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('absen').setLabel('Absen').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ijin').setLabel('Ijin').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('lanjut').setLabel('Lanjut').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('off').setLabel('Off').setStyle(ButtonStyle.Danger),
    );

    const msgs = await ch.messages.fetch({ limit: 50 });
    const botMsg = msgs.find(m => m.author?.id === client.user.id && m.embeds?.[0]?.title === 'Panel Absen & Leaderboard Staff');

    if (botMsg) {
      await botMsg.edit({ embeds: [embed], components: [row] });
    } else {
      await ch.send({ embeds: [embed], components: [row] });
    }
  } catch (err) {
    console.error('postOrUpdatePanel err', err.message || err);
  }
}

// interactions (buttons + commands)
client.on('interactionCreate', async (interaction) => {
  try {
    // command (slash)
    if (interaction.isChatInputCommand()) {
      const cmd = client.commands.get(interaction.commandName);
      if (!cmd) return;
      return cmd.execute(interaction);
    }

    // button
    if (interaction.isButton()) {
      const uid = interaction.user.id;
      // only staff can press
      const staffRole = await db.getSetting('staff_role');
      const member = interaction.member;
      if (staffRole && !member.roles.cache.has(staffRole)) {
        return interaction.reply({ content: 'Hanya staff yang bisa tekan tombol ini.', ephemeral: true });
      }
      await db.ensureStaff(uid, interaction.user.username);
      if (interaction.customId === 'absen') {
        await supabase.from('staff').update({ status: 'active', updated_at: new Date().toISOString() }).eq('discord_id', uid);
        await interaction.reply({ content: '✅ Kamu sekarang absen (active).', ephemeral: true });
      } else if (interaction.customId === 'ijin') {
        await supabase.from('staff').update({ status: 'paused', updated_at: new Date().toISOString() }).eq('discord_id', uid);
        await interaction.reply({ content: '⏸️ Kamu ijin. Counting dihentikan.', ephemeral: true });
      } else if (interaction.customId === 'lanjut') {
        await supabase.from('staff').update({ status: 'active', updated_at: new Date().toISOString() }).eq('discord_id', uid);
        await interaction.reply({ content: '▶️ Counting dilanjutkan.', ephemeral: true });
      } else if (interaction.customId === 'off') {
        await supabase.from('staff').update({ status: 'off', updated_at: new Date().toISOString() }).eq('discord_id', uid);
        await interaction.reply({ content: '⏹️ Kamu off. Counting berhenti.', ephemeral: true });
      }
      // update panel after status change
      setTimeout(() => postOrUpdatePanel().catch(()=>{}), 1000);
    }
  } catch (err) {
    console.error('interactionCreate err', err);
  }
});

// message counting
client.on('messageCreate', async (msg) => {
  try {
    if (msg.author?.bot) return;
    // get monitored channels from settings
    const monitored = (await db.getSetting('monitored_channels')) || process.env.MONITORED_CHANNEL_IDS || '';
    const monitoredIds = monitored.split(',').map(s=>s.trim()).filter(Boolean);
    if (!monitoredIds.includes(msg.channel.id)) return;
    const member = msg.member;
    if (!member) return;

    const staffRole = await db.getSetting('staff_role');
    if (staffRole && !member.roles.cache.has(staffRole)) return;

    // check staff status
    const { data: row } = await supabase.from('staff').select('status').eq('discord_id', member.id).single();
    const status = (row && row.status) || 'off';
    if (status !== 'active') return;

    await db.incrementMessageCount(member.id, msg.channel.id);
    // update panel occasionally (debounce handled by interval)
  } catch (err) {
    console.error('messageCreate err', err);
  }
});

// voiceStateUpdate -> stage handling (single or role mode)
client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    const newCh = newState.channel;
    const oldCh = oldState.channel;
    const user = (newState.member || oldState.member);
    if (!user) return;
    const stageMode = (await db.getSetting('stage_mode')) || 'single';

    if (stageMode === 'single') {
      const modId = await db.getSetting('stage_mod');
      if (!modId) return;
      if (newCh && user.id === modId && newCh.type === 13) await db.startStageSession(modId);
      if (oldCh && user.id === modId && oldCh.type === 13 && (!newCh || newCh.id !== oldCh.id)) await db.endStageSession(modId);
    } else { // role mode
      const staffRole = await db.getSetting('staff_role');
      if (!staffRole) return;
      // ensure member object has roles
      const hasRole = user.roles?.cache?.has ? user.roles.cache.has(staffRole) : false;
      if (!hasRole) return;
      if (newCh && newCh.type === 13) await db.startStageSession(user.id);
      if (oldCh && oldCh.type === 13 && (!newCh || newCh.id !== oldCh.id)) await db.endStageSession(user.id);
    }
  } catch (err) {
    console.error('voiceStateUpdate err', err);
  }
});

client.once('ready', async () => {
  console.log('Logged in as', client.user.tag);

  // register slash commands globally (or change to guild-specific if testing)
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const data = client.commands.map(c => c.data.toJSON());
    await rest.put(Routes.applicationCommands(client.user.id), { body: data });
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error('Failed register commands', err);
  }

  // initial panel post & update loop
  await postOrUpdatePanel();
  setInterval(() => postOrUpdatePanel().catch(()=>{}), 30_000);
});

client.login(DISCORD_TOKEN).catch(err => {
  console.error('login failed', err);
  process.exit(1);
});
