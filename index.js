// index.js (final)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Partials, Collection, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ChannelType } = require('discord.js');
const supabase = require('./supabase-client'); // must exist
const db = require('./db-helpers'); // must exist and export needed helpers

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN missing in env');
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

// load commands from /commands
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
if (fs.existsSync(commandsPath)) {
  const files = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const cmd = require(path.join(commandsPath, f));
    client.commands.set(cmd.data.name, cmd);
  }
}

// Build and post/update single panel message (embed + buttons)
async function postOrUpdatePanel() {
  try {
    const staffChannelId = await db.getSetting('staff_channel');
    const leaderboardChannelId = await db.getSetting('leaderboard_channel');
    const panelChannelId = staffChannelId || leaderboardChannelId;
    if (!panelChannelId) return;

    const ch = await client.channels.fetch(panelChannelId).catch(() => null);
    if (!ch) return;

    const rows = await db.getLeaderboard(50);
    const desc = rows.map((r, i) => {
      const name = r.display_name || `<@${r.discord_id}>`;
      const pts = Number(r.points || 0).toFixed(2);
      return `**${i+1}.** ${name} — ${pts} pts (msgs:${r.messages_count||0}, mins:${r.minutes_on_stage||0})`;
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
      new ButtonBuilder().setCustomId('off').setLabel('Off').setStyle(ButtonStyle.Danger)
    );

    const fetched = await ch.messages.fetch({ limit: 50 }).catch(() => null);
    const botMsg = fetched ? fetched.find(m => m.author?.id === client.user.id && m.embeds?.[0]?.title === 'Panel Absen & Leaderboard Staff') : null;

    if (botMsg) {
      await botMsg.edit({ embeds: [embed], components: [row] });
    } else {
      await ch.send({ embeds: [embed], components: [row] });
    }
  } catch (err) {
    console.error('postOrUpdatePanel err', err);
  }
}

// Interaction handler: slash commands + buttons
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = client.commands.get(interaction.commandName);
      if (!cmd) return;
      return cmd.execute(interaction);
    }

    if (interaction.isButton()) {
      const uid = interaction.user.id;
      // check staff role if set
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

      // update panel shortly after status change
      setTimeout(() => postOrUpdatePanel().catch(() => {}), 800);
    }
  } catch (err) {
    console.error('interactionCreate err', err);
    if (interaction.replied || interaction.deferred) {
      try { await interaction.followUp({ content: 'Terjadi error.', ephemeral: true }); } catch {}
    } else {
      try { await interaction.reply({ content: 'Terjadi error.', ephemeral: true }); } catch {}
    }
  }
});

// message counting per-user in monitored channels
client.on('messageCreate', async (msg) => {
  try {
    if (msg.author?.bot) return;

    // monitored channels stored in settings OR fallback env
    const monitored = (await db.getSetting('monitored_channels')) || process.env.MONITORED_CHANNEL_IDS || '';
    const monitoredIds = monitored.split(',').map(s => s.trim()).filter(Boolean);
    if (monitoredIds.length > 0 && !monitoredIds.includes(msg.channel.id)) return;

    const member = msg.member;
    if (!member) return;

    const staffRole = await db.getSetting('staff_role');
    if (staffRole && !member.roles.cache.has(staffRole)) return;

    // check staff status
    const { data: row, error } = await supabase.from('staff').select('status').eq('discord_id', member.id).single();
    const status = (row && row.status) || 'off';
    if (status !== 'active') return;

    // increment atomically via RPC or fallback handled in db-helpers
    await db.incrementMessageCount(member.id, msg.channel.id);

    // optional: update panel less frequently (we use interval)
  } catch (err) {
    console.error('messageCreate err', err);
  }
});

// voiceStateUpdate -> stage handling (single or role mode)
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
    } else { // role mode
      const staffRole = await db.getSetting('staff_role');
      if (!staffRole) return;
      // ensure member has roles cache; fetch if partial
      const guild = userMember.guild;
      const member = (userMember.partial ? await guild.members.fetch(userMember.id).catch(()=>null) : userMember);
      if (!member) return;
      if (!member.roles.cache.has(staffRole)) return;

      if (newCh && newCh.type === ChannelType.GuildStageVoice) {
        await db.startStageSession(member.id);
      }
      if (oldCh && oldCh.type === ChannelType.GuildStageVoice && (!newCh || newCh.id !== oldCh.id)) {
        await db.endStageSession(member.id);
      }
    }
  } catch (err) {
    console.error('voiceStateUpdate err', err);
  }
});

client.once('ready', async () => {
  console.log('Logged in as', client.user.tag);

  // register slash commands (guild-scoped if GUILD_ID set)
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const data = client.commands.map(c => c.data.toJSON());

    const GUILD_ID = process.env.GUILD_ID;
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: data });
      console.log('✅ Slash commands registered to GUILD', GUILD_ID);
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), { body: data });
      console.log('✅ Slash commands registered globally');
    }
  } catch (err) {
    console.error('Failed register commands', err);
  }

  // initial panel post & update loop
  await postOrUpdatePanel();
  setInterval(() => postOrUpdatePanel().catch(() => {}), 30_000);
});

client.login(DISCORD_TOKEN).catch(err => {
  console.error('login failed', err);
  process.exit(1);
});
