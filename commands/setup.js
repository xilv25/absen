// commands/setup.js
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { setSetting } = require('../db-helpers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Setup bot attendance')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('staffrole').setDescription('Set role staff').addRoleOption(o => o.setName('role').setRequired(true)))
    .addSubcommand(s => s.setName('staffchannel').setDescription('Set channel untuk panel absen').addChannelOption(o => o.setName('channel').setRequired(true)))
    .addSubcommand(s => s.setName('leaderboard').setDescription('Set channel leaderboard (bisa sama staffchannel)').addChannelOption(o => o.setName('channel').setRequired(true)))
    .addSubcommand(s => s.setName('monitored').setDescription('Set channel yang dipantau (max 5)').addStringOption(o => o.setName('channels').setDescription('Masukkan channel IDs dipisah koma').setRequired(true)))
    .addSubcommand(s => s.setName('stagemod').setDescription('Set single stage moderator (user id)').addUserOption(o => o.setName('user').setRequired(true)))
    .addSubcommand(s => s.setName('stage-mode').setDescription('Set stage mode single atau role').addStringOption(o => o.setName('mode').addChoices({ name: 'single', value: 'single' }, { name: 'role', value: 'role' }).setRequired(true))),
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'staffrole') {
      const role = interaction.options.getRole('role');
      await setSetting('staff_role', role.id);
      await interaction.reply({ content: `✅ Role staff diset: <@&${role.id}>`, ephemeral: true });
    } else if (sub === 'staffchannel') {
      const ch = interaction.options.getChannel('channel');
      await setSetting('staff_channel', ch.id);
      await interaction.reply({ content: `✅ Channel panel diset: <#${ch.id}>`, ephemeral: true });
    } else if (sub === 'leaderboard') {
      const ch = interaction.options.getChannel('channel');
      await setSetting('leaderboard_channel', ch.id);
      await interaction.reply({ content: `✅ Channel leaderboard diset: <#${ch.id}>`, ephemeral: true });
    } else if (sub === 'monitored') {
      const list = interaction.options.getString('channels').split(',').map(s => s.trim()).filter(Boolean).slice(0,5);
      await setSetting('monitored_channels', list.join(','));
      await interaction.reply({ content: `✅ Channel dipantau diset: ${list.map(x=>`<#${x}>`).join(', ')}`, ephemeral: true });
    } else if (sub === 'stagemod') {
      const user = interaction.options.getUser('user');
      await setSetting('stage_mod', user.id);
      await interaction.reply({ content: `✅ Stage moderator diset: <@${user.id}>`, ephemeral: true });
    } else if (sub === 'stage-mode') {
      const mode = interaction.options.getString('mode');
      await setSetting('stage_mode', mode);
      await interaction.reply({ content: `✅ Stage mode diset ke: **${mode}**`, ephemeral: true });
    }
  }
};
