// commands/setup.js
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { setSetting } = require('../db-helpers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Setup bot attendance')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('staffrole').setDescription('Set role staff').addRoleOption(o => o.setName('role').setRequired(true)))
    .addSubcommand(s => s.setName('staffchannel').setDescription('Set channel panel staff').addChannelOption(o => o.setName('channel').setRequired(true)))
    .addSubcommand(s => s.setName('leaderboard').setDescription('Set channel leaderboard (boleh sama)').addChannelOption(o => o.setName('channel').setRequired(true)))
    .addSubcommand(s => s.setName('monitored').setDescription('Set channel yang dipantau (ID dipisah koma)').addStringOption(o => o.setName('channels').setRequired(true)))
    .addSubcommand(s => s.setName('stagemod').setDescription('Set moderator stage (single mode)').addUserOption(o => o.setName('user').setRequired(true)))
    .addSubcommand(s => s.setName('stage-mode').setDescription('Pilih mode stage').addStringOption(o => o.setName('mode').addChoices(
      { name: 'single', value: 'single' },
      { name: 'role', value: 'role' }
    ).setRequired(true))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'staffrole') {
      const role = interaction.options.getRole('role');
      await setSetting('staff_role', role.id);
      return interaction.reply({ content: `✅ Role staff diset: <@&${role.id}>`, ephemeral: true });
    }
    if (sub === 'staffchannel') {
      const ch = interaction.options.getChannel('channel');
      await setSetting('staff_channel', ch.id);
      return interaction.reply({ content: `✅ Channel panel: <#${ch.id}>`, ephemeral: true });
    }
    if (sub === 'leaderboard') {
      const ch = interaction.options.getChannel('channel');
      await setSetting('leaderboard_channel', ch.id);
      return interaction.reply({ content: `✅ Channel leaderboard: <#${ch.id}>`, ephemeral: true });
    }
    if (sub === 'monitored') {
      const list = interaction.options.getString('channels').split(',').map(s => s.trim()).filter(Boolean);
      await setSetting('monitored_channels', list.join(','));
      return interaction.reply({ content: `✅ Channel dipantau: ${list.map(x => `<#${x}>`).join(', ')}`, ephemeral: true });
    }
    if (sub === 'stagemod') {
      const user = interaction.options.getUser('user');
      await setSetting('stage_mod', user.id);
      return interaction.reply({ content: `✅ Moderator stage: <@${user.id}>`, ephemeral: true });
    }
    if (sub === 'stage-mode') {
      const mode = interaction.options.getString('mode');
      await setSetting('stage_mode', mode);
      return interaction.reply({ content: `✅ Stage mode diset ke **${mode}**`, ephemeral: true });
    }
  }
};
