// index.js (FINAL)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType
} = require('discord.js');

const supabase = require('./supabase-client');
const db = require('./db-helpers');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN missing');
  process.exit(1);
}

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

/** Helper: make a 10-char progress bar from fraction [0..1] */
function progressBar(fraction, length = 10) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * length);
  const empty = length - filled;
  const bar = '▰'.repeat(filled) + '▱'.repeat(empty);
  const percent = Math.round(clamped * 100);
  return `${bar} ${percent}%`;
}

// Panel posting (dark + accent #00cf91 + progress bars)
async function postOrUpdatePanel() {
  try {
    const staffChannelId = await db.getSetting('staff_channel');
    const leaderboardChannelId = await db.getSetting('leaderboard_channel');
    const panelChannelId = staffChannelId || leaderboardChannelId;
    if (!panelChannelId) return;

    const ch = await client.channels.fetch(panelChannelId).catch(() => null);
    if (!ch) return;

    const rows = await db.getLeaderboard(50);
    const { data: allStaff } = await supabase.from('staff').select('discord_id, status, display_name, points').order('points', { ascending: false });

    // Build top list (limit 12)
    const top = rows.slice(0, 12);
    const lbLines = top.map((r, i) => {
      const isPlaceholder = !r.display_name || /^staff\d*$/i.test(String(r.display_name).trim());
      const name = isPlaceholder ? `<@${r.discord_id}> — *klik Absen untuk register*` : `**${r.display_name}**`;
      const pts = Number(r.points || 0);
      const whole = Math.floor(pts);
      const frac = pts - whole;
      const bar = progressBar(frac, 10);
      return `\`${String(i + 1).padStart(2, ' ')}.\` ${name}\n• **${pts.toFixed(2)} pts** ${bar}\n• msgs: ${r.messages_count||0} • mins: ${r.minutes_on_stage||0}`;
    }).join('\n\n') || '_Belum ada data leaderboard_';

    // grouped statuses
    const grouped = { active: [], paused: [], off: [] };
    (allStaff || []).forEach(s => {
      const isPlaceholder = !s.display_name || /^staff\d*$/i.test(String(s.display_name).trim());
      const name = isPlaceholder ? `<@${s.discord_id}>` : s.display_name;
      grouped[s.status === 'active' ? 'active' : s.status === 'paused' ? 'paused' : 'off'].push(name);
    });

    const activeList = grouped.active.length ? grouped.active.join(', ') : '—';
    const pausedList = grouped.paused.length ? grouped.paused.join(', ') : '—';
    const offList = grouped.off.length ? grouped.off.join(', ') : '—';

    // author/thumbnail
    const guild = ch.guild;
    const logoUrl = process.env.PANEL_LOGO_URL || (guild && guild.iconURL({ size: 256 }));
    const authorName = guild ? `${guild.name} · Panel Staff` : 'Panel Staff';

    // accent color #00cf91
    const accent = 0x00cf91;

    const embed = new EmbedBuilder()
      .setColor(accent)
      .setAuthor({ name: authorName, iconURL: logoUrl || undefined })
      .setTitle('Absensi & Leaderboard — Dark')
      .setDescription('**Realtime** · 100 msgs = 1 pt · 30 mins on stage = 1 pt\nKlik tombol di bawah untuk daftar / ubah status.')
      .addFields(
        { name: `Top ${top.length}`, value: lbLines, inline: false },
        { name: 'Aktif Sekarang', value: activeList, inline: true },
        { name: 'Ijin (Paused)', value: pausedList, inline: true },
        { name: 'Off', value: offList, inline: true }
      )
      .setFooter({ text: 'Panel otomatis terupdate tiap 30 detik.' })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('absen').setLabel('Absen').setEmoji('🟢').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ijin').setLabel('Ijin').setEmoji('⏸️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('lanjut').setLabel('Lanjut').setEmoji('▶️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('off').setLabel('Off').setEmoji('⏹️').setStyle(ButtonStyle.Danger)
    );

    const fetched = await ch.messages.fetch({ limit: 50 }).catch(() => null);
    const botMsg = fetched ? fetched.find(m => m.author?.id === client.user.id && m.embeds?.[0]?.title === 'Absensi & Leaderboard — Dark') : null;

    if (botMsg) {
      await botMsg.edit({ embeds: [embed], components: [row] });
    } else {
      await ch.send({ embeds: [embed], components: [row] });
    }
  } catch (err) {
    console.error('postOrUpdatePanel error', err);
  }
}

// interactions handler
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = client.commands.get(interaction.commandName);
      if (!cmd) return;
      return cmd.execute(interaction);
    }

    if (interaction.isButton()) {
      const uid = interaction.user.id;
      const staffRole = await db.getSetting('staff_role');
      const member = interaction.member;
      if (staffRole && !member.roles.cache.has(staffRole)) {
        return interaction.reply({ content: 'Hanya staff yang bisa tekan tombol ini.', ephemeral: true });
      }

      if (interaction.customId === 'absen') {
        const displayName = (interaction.member && interaction.member.nickname) || interaction.user.username;
        await db.ensureStaff(uid, displayName);
        await supabase.from('staff').update({ status: 'active', display_name: displayName, updated_at: new Date().toISOString() }).eq('discord_id', uid);
        await interaction.reply({ content: `✅ Kamu sekarang absen. Nama terdaftar: **${displayName}**`, ephemeral: true });
      } else if (interaction.customId === 'ijin') {
        await db.ensureStaff(uid);
        await supabase.from('staff').update({ status: 'paused', updated_at: new Date().toISOString() }).eq('discord_id', uid);
        await interaction.reply({ content: '⏸️ Kamu ijin. Counting dihentikan.', ephemeral: true });
      } else if (interaction.customId === 'lanjut') {
        await db.ensureStaff(uid);
        await supabase.from('staff').update({ status: 'active', updated_at: new Date().toISOString() }).eq('discord_id', uid);
        await interaction.reply({ content: '▶️ Counting dilanjutkan.', ephemeral: true });
      } else if (interaction.customId === 'off') {
        await db.ensureStaff(uid);
        await supabase.from('staff').update({ status: 'off', updated_at: new Date().toISOString() }).eq('discord_id', uid);
        await interaction.reply({ content: '⏹️ Kamu off. Counting berhenti.', ephemeral: true });
      }

      // small delay then update panel
      setTimeout(() => postOrUpdatePanel().catch(() => {}), 900);
    }
  } catch (err) {
    console.error('interactionCreate err', err);
    try { if (!interaction.replied) await interaction.reply({ content: 'Terjadi error.', ephemeral: true }); } catch {}
  }
});

// message counting
client.on('messageCreate', async (msg) => {
  try {
    if (msg.author?.bot) return;
    const monitored = (await db.getSetting('monitored_channels')) || process.env.MONITORED_CHANNEL_IDS || '';
    const monitoredIds = monitored.split(',').map(s => s.trim()).filter(Boolean);
    if (monitoredIds.length > 0 && !monitoredIds.includes(msg.channel.id)) return;

    const member = msg.member;
    if (!member) return;

    const staffRole = await db.getSetting('staff_role');
    if (staffRole && !member.roles.cache.has(staffRole)) return;

    const { data: row } = await supabase.from('staff').select('status').eq('discord_id', member.id).single();
    const status = (row && row.status) || 'off';
    if (status !== 'active') return;

    await db.incrementMessageCount(member.id, msg.channel.id);
  } catch (err) {
    console.error('messageCreate err', err);
  }
});

// voice state -> stage sessions
client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    const newCh = newState.channel;
    const oldCh = oldState.channel;
    const userMember = (newState.member || oldState.member);
    if (!userMember) return;

    const stageMode = (await db.getSetting('stage_mode')) || 'single';

    if (stageMode === 'single') {
      const modId = await db.getSetting('stage_mod');
      if (!modId) return;
      if (newCh && userMember.id === modId && newCh.type === ChannelType.GuildStageVoice) {
        await db.startStageSession(modId);
      }
      if (oldCh && userMember.id === modId && oldCh.type === ChannelType.GuildStageVoice && (!newCh || newCh.id !== oldCh.id)) {
        await db.endStageSession(modId);
      }
    } else {
      const staffRole = await db.getSetting('staff_role');
      if (!staffRole) return;
      const guild = userMember.guild;
      const member = (userMember.partial ? await guild.members.fetch(userMember.id).catch(() => null) : userMember);
      if (!member) return;
      if (!member.roles.cache.has(staffRole)) return;

      if (newCh && newCh.type === ChannelType.GuildStageVoice) await db.startStageSession(member.id);
      if (oldCh && oldCh.type === ChannelType.GuildStageVoice && (!newCh || newCh.id !== oldCh.id)) await db.endStageSession(member.id);
    }
  } catch (err) {
    console.error('voiceStateUpdate err', err);
  }
});

client.once('ready', async () => {
  console.log('Logged in as', client.user.tag);

  // register slash commands (guild-scoped if GUILD_ID present for fast deploy)
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const data = client.commands.map(c => c.data.toJSON());
    const GUILD_ID = process.env.GUILD_ID;
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: data });
      console.log('Slash commands registered to GUILD', GUILD_ID);
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), { body: data });
      console.log('Slash commands registered globally');
    }
  } catch (err) {
    console.error('Failed register commands', err);
  }

  // initial panel
  await postOrUpdatePanel();
  setInterval(() => postOrUpdatePanel().catch(() => {}), 30_000);
});

client.login(DISCORD_TOKEN).catch(err => {
  console.error('login failed', err);
  process.exit(1);
});
