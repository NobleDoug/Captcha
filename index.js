require("dotenv").config();
const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Events,
  PermissionsBitField,
  AttachmentBuilder,
} = require("discord.js");

// ===== Client =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // !setup-verificacao
  ],
  partials: [Partials.Channel],
});

// ===== .env =====
const TOKEN = process.env.DISCORD_TOKEN;
const VERIFY_CHANNEL_ID = process.env.VERIFY_CHANNEL_ID;
const VISITOR_ROLE_ID = process.env.VISITOR_ROLE_ID;
const MEMBER_ROLE_ID = process.env.MEMBER_ROLE_ID;

const STAFF_LOG_CHANNEL_ID = process.env.STAFF_LOG_CHANNEL_ID;
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID;

const VERIFY_TIMEOUT_MINUTES = Number(process.env.VERIFY_TIMEOUT_MINUTES || 2);
const KICK_ON_TIMEOUT = String(process.env.KICK_ON_TIMEOUT || "false") === "true";

const MIN_ACCOUNT_AGE_DAYS = Number(process.env.MIN_ACCOUNT_AGE_DAYS || 0);
const KICK_TOO_NEW = String(process.env.KICK_TOO_NEW || "false") === "true";

// ===== imagem local =====
const IMAGE_FILENAME = "verificacao.png";
const IMAGE_PATH = path.join(__dirname, "img", IMAGE_FILENAME);

// ===== “DB” local =====
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "pending.json");

// guildId -> userId -> { code, expiresAt, createdAt, attempts }
let pending = {};

// ---------- Utils ----------
function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({}, null, 2), "utf8");
}

function loadDB() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    pending = JSON.parse(raw || "{}");
  } catch {
    pending = {};
  }
}

function saveDB() {
  ensureDataFile();
  fs.writeFileSync(DB_PATH, JSON.stringify(pending, null, 2), "utf8");
}

function getEntry(guildId, userId) {
  return pending?.[guildId]?.[userId] || null;
}

function setEntry(guildId, userId, entry) {
  pending[guildId] = pending[guildId] || {};
  pending[guildId][userId] = entry;
  saveDB();
}

function delEntry(guildId, userId) {
  if (!pending[guildId]) return;
  delete pending[guildId][userId];
  if (Object.keys(pending[guildId]).length === 0) delete pending[guildId];
  saveDB();
}

function generateCode(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function accountAgeDays(user) {
  const created = user.createdTimestamp;
  const days = (Date.now() - created) / (1000 * 60 * 60 * 24);
  return days;
}

async function sendStaffLog(guild, embed) {
  if (!STAFF_LOG_CHANNEL_ID) return;
  const ch = await guild.channels.fetch(STAFF_LOG_CHANNEL_ID).catch(() => null);
  if (ch && ch.isTextBased()) ch.send({ embeds: [embed] }).catch(() => null);
}

async function sendWelcome(guild, member) {
  if (!WELCOME_CHANNEL_ID) return;
  const ch = await guild.channels.fetch(WELCOME_CHANNEL_ID).catch(() => null);
  if (!ch || !ch.isTextBased()) return;
  ch.send(`🎉 Bem-vindo(a) ${member}! Você foi verificado e agora faz parte do clã! ⚔️`).catch(() => null);
}

// ---------- UI ----------
function buildVerifyEmbed() {
  return new EmbedBuilder()
    .setTitle("🔒 Verificação necessária")
    .setDescription(
      "Para ganhar acesso ao servidor, você precisa completar a verificação.\n\n" +
        "1) Clique em **Verificar**\n" +
        "2) Você verá seu código (só você verá)\n" +
        "3) Digite o código no formulário e envie ✅\n\n" +
        `⏳ Tempo limite: **${VERIFY_TIMEOUT_MINUTES} min**`
    )
    .setColor(0xff0000)
    .setImage(`attachment://${IMAGE_FILENAME}`)
    .setFooter({ text: "Verifique apenas dentro deste servidor" });
}

function buildVerifyRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("verify_btn").setLabel("Verificar").setStyle(ButtonStyle.Primary)
  );
}

// ---------- Startup ----------
client.once(Events.ClientReady, () => {
  loadDB();
  console.log(`✅ Logado como ${client.user.tag}`);
  console.log("VERIFY_CHANNEL_ID:", VERIFY_CHANNEL_ID);
  console.log("VISITOR_ROLE_ID:", VISITOR_ROLE_ID);
  console.log("MEMBER_ROLE_ID:", MEMBER_ROLE_ID);
  console.log("STAFF_LOG_CHANNEL_ID:", STAFF_LOG_CHANNEL_ID);
  console.log("WELCOME_CHANNEL_ID:", WELCOME_CHANNEL_ID);
  console.log("IMAGE_PATH:", IMAGE_PATH);
  console.log("KICK_ON_TIMEOUT:", KICK_ON_TIMEOUT);
  console.log("MIN_ACCOUNT_AGE_DAYS:", MIN_ACCOUNT_AGE_DAYS, "KICK_TOO_NEW:", KICK_TOO_NEW);

  // sweeper: expira e kick (mesmo após reiniciar)
  setInterval(async () => {
    try {
      for (const [guildId, guild] of client.guilds.cache) {
        const guildPending = pending[guildId];
        if (!guildPending) continue;

        for (const userId of Object.keys(guildPending)) {
          const entry = guildPending[userId];
          if (!entry) continue;

          if (Date.now() > entry.expiresAt) {
            delEntry(guildId, userId);

            if (KICK_ON_TIMEOUT) {
              const member = await guild.members.fetch(userId).catch(() => null);
              if (member) {
                await member.kick(`Não verificou em ${VERIFY_TIMEOUT_MINUTES} minutos.`).catch(() => null);

                const e = new EmbedBuilder()
                  .setTitle("⏳ Expulso por timeout de verificação")
                  .setColor(0xff0000)
                  .addFields(
                    { name: "Usuário", value: `${member.user.tag} (${member.id})`, inline: false },
                    { name: "Motivo", value: `Não verificou em ${VERIFY_TIMEOUT_MINUTES} min`, inline: false }
                  )
                  .setTimestamp();

                await sendStaffLog(guild, e);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error("Erro no sweeper:", err);
    }
  }, 30_000);
});

// ---------- Member Join ----------
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const guildId = member.guild.id;
    const userId = member.id;

    console.log("📥 Entrou:", member.user.tag, member.id);

    // Anti-alt: conta muito nova
    if (MIN_ACCOUNT_AGE_DAYS > 0) {
      const age = accountAgeDays(member.user);
      if (age < MIN_ACCOUNT_AGE_DAYS) {
        const embed = new EmbedBuilder()
          .setTitle("🛡️ Anti-alt: conta muito nova")
          .setColor(0xff0000)
          .addFields(
            { name: "Usuário", value: `${member.user.tag} (${member.id})`, inline: false },
            { name: "Idade da conta", value: `${age.toFixed(2)} dias`, inline: true },
            { name: "Mínimo exigido", value: `${MIN_ACCOUNT_AGE_DAYS} dias`, inline: true }
          )
          .setTimestamp();

        await sendStaffLog(member.guild, embed);

        if (KICK_TOO_NEW) {
          await member.kick(
            `Conta muito nova (${age.toFixed(2)} dias). Mínimo: ${MIN_ACCOUNT_AGE_DAYS} dias.`
          ).catch(() => null);
          return;
        }
      }
    }

    // cargo visitante
    if (VISITOR_ROLE_ID) {
      await member.roles.add(VISITOR_ROLE_ID).catch(() => null);
    }

    // cria/atualiza entry
    const existing = getEntry(guildId, userId);
    const code = existing?.code || generateCode(6);
    const expiresAt = Date.now() + VERIFY_TIMEOUT_MINUTES * 60 * 1000;

    setEntry(guildId, userId, {
      code,
      createdAt: existing?.createdAt || Date.now(),
      expiresAt,
      attempts: existing?.attempts || 0,
    });

    console.log(`🔐 Código para ${member.user.tag}: ${code}`);
  } catch (err) {
    console.error("Erro no GuildMemberAdd:", err);
  }
});

// ---------- Command: setup panel ----------
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;

    if (message.content === "!setup-verificacao") {
      const isAdmin = message.member.permissions.has(PermissionsBitField.Flags.Administrator);
      if (!isAdmin) return message.reply("❌ Você precisa ser Admin para usar esse comando.");

      const channel = await message.guild.channels.fetch(VERIFY_CHANNEL_ID).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        return message.reply("❌ VERIFY_CHANNEL_ID inválido ou não é canal de texto.");
      }

      const img = new AttachmentBuilder(IMAGE_PATH);

      await channel.send({
        embeds: [buildVerifyEmbed()],
        components: [buildVerifyRow()],
        files: [img],
      });

      return message.reply("✅ Painel de verificação criado no canal configurado.");
    }
  } catch (err) {
    console.error("Erro no MessageCreate:", err);
  }
});

// ---------- Interactions ----------
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Botão Verificar
    if (interaction.isButton() && interaction.customId === "verify_btn") {
      const guildId = interaction.guild.id;
      const userId = interaction.user.id;

      const entry = getEntry(guildId, userId);
      if (!entry) {
        return interaction.reply({
          ephemeral: true,
          content: "Você ainda não tem um código (ou ele expirou). Saia e entre novamente no servidor.",
        });
      }

      if (Date.now() > entry.expiresAt) {
        delEntry(guildId, userId);
        return interaction.reply({ ephemeral: true, content: "⏳ Seu código expirou. Saia e entre novamente." });
      }

      // modal
      const modal = new ModalBuilder().setCustomId("verify_modal").setTitle("Verificação");

      const codeInput = new TextInputBuilder()
        .setCustomId("code")
        .setLabel("Digite o seu código de verificação")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("Ex: A7K4Q9")
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(codeInput));

      await interaction.showModal(modal);

      // mostra código só pra pessoa
      return interaction.followUp({
        ephemeral: true,
        content: `🔐 Seu código é: **\`${entry.code}\`** (expira em ${VERIFY_TIMEOUT_MINUTES} min)`,
      });
    }

    // Modal submit
    if (interaction.isModalSubmit() && interaction.customId === "verify_modal") {
      const guildId = interaction.guild.id;
      const userId = interaction.user.id;

      const entry = getEntry(guildId, userId);
      if (!entry) {
        return interaction.reply({
          ephemeral: true,
          content: "Você não tem verificação pendente (ou expirou). Saia e entre novamente.",
        });
      }

      if (Date.now() > entry.expiresAt) {
        delEntry(guildId, userId);
        return interaction.reply({ ephemeral: true, content: "⏳ Seu código expirou. Saia e entre novamente." });
      }

      const typed = interaction.fields.getTextInputValue("code").trim().toUpperCase();

      // tentativas
      entry.attempts = (entry.attempts || 0) + 1;
      setEntry(guildId, userId, entry);

      // ✅ Kick por 3 erros
      if (typed !== entry.code) {
        if (entry.attempts >= 3) {
          delEntry(guildId, userId);

          const member = await interaction.guild.members.fetch(userId).catch(() => null);
          if (member) {
            await member.kick("Errou o código 3 vezes.").catch(() => null);

            const e = new EmbedBuilder()
              .setTitle("🚫 Expulso por 3 tentativas")
              .setColor(0xff0000)
              .addFields(
                { name: "Usuário", value: `${member.user.tag} (${member.id})`, inline: false },
                { name: "Motivo", value: "Errou o código 3 vezes", inline: false }
              )
              .setTimestamp();

            await sendStaffLog(interaction.guild, e);
          }

          return interaction.reply({
            ephemeral: true,
            content: "🚫 Você errou 3 vezes e foi expulso. Entre novamente para tentar de novo.",
          });
        }

        return interaction.reply({
          ephemeral: true,
          content: `❌ Código incorreto. Tentativas: ${entry.attempts}/3`,
        });
      }

      // sucesso
      delEntry(guildId, userId);

      const member = await interaction.guild.members.fetch(userId).catch(() => null);
      if (!member) {
        return interaction.reply({ ephemeral: true, content: "❌ Não consegui acessar seu usuário no servidor." });
      }

      if (VISITOR_ROLE_ID) await member.roles.remove(VISITOR_ROLE_ID).catch(() => null);
      if (MEMBER_ROLE_ID) await member.roles.add(MEMBER_ROLE_ID).catch(() => null);

      // log staff
      const age = accountAgeDays(member.user);
      const embed = new EmbedBuilder()
        .setTitle("✅ Membro verificado")
        .setColor(0x00ff66)
        .addFields(
          { name: "Usuário", value: `${member.user.tag} (${member.id})`, inline: false },
          { name: "Idade da conta", value: `${age.toFixed(2)} dias`, inline: true },
          { name: "Tentativas", value: `${entry.attempts || 1}`, inline: true }
        )
        .setTimestamp();

      await sendStaffLog(interaction.guild, embed);

      // boas-vindas
      await sendWelcome(interaction.guild, member);

      return interaction.reply({
        ephemeral: true,
        content: "✅ Verificação concluída! Você recebeu acesso ao servidor.",
      });
    }
  } catch (err) {
    console.error("🔥 ERRO InteractionCreate:", err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({ ephemeral: true, content: "❌ Erro interno. Veja o terminal do bot." });
      } catch {}
    }
  }
});

// Captura erros “silenciosos”
process.on("unhandledRejection", (reason) => console.error("UNHANDLED REJECTION:", reason));
process.on("uncaughtException", (err) => console.error("UNCAUGHT EXCEPTION:", err));

loadDB();
client.login(TOKEN);
