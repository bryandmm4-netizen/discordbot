//Bryandmm (Criador);


// index.mjs
import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
} from "@discordjs/voice";
import fs from "fs";
import path from "path";
import { spawn, execSync } from "child_process";

// ======================
// VARIÁVEIS
// ======================

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
// GUILD_IDS no .env: separado por vírgula, ex: GUILD_IDS=111,222,333
const GUILD_IDS = process.env.GUILD_IDS?.split(",").map((id) => id.trim());

if (!TOKEN || !CLIENT_ID || !GUILD_IDS?.length) {
  console.error("❌ Faltam variáveis no .env (DISCORD_TOKEN, CLIENT_ID, GUILD_IDS)");
  process.exit(1);
}

const cacheDir = path.join(process.cwd(), "cache");
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const queues = new Map(); // guildId => { tracks, previous, current, player, connection, playing, message, textChannel }
const MAX_PARALLEL_DOWNLOADS = 1;
let activeDownloads = 0;
const pendingDownloads = new Map(); // guildId => [funções pendentes]
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24h

// ======================
// HELPERS: detectar vídeo/playlist
// ======================

function getVideoIdFromUrl(url) {
  try {
    // youtu.be/<id>
    const ytb = url.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
    if (ytb?.[1]) return ytb[1];

    // youtube.com/watch?v=<id>
    const v = url.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
    if (v?.[1]) return v[1];

    return null;
  } catch {
    return null;
  }
}

function isPurePlaylistUrl(url) {
  // Playlist sem "v=" nem youtu.be/<id> → trata como playlist completa
  const hasList = /[?&]list=/.test(url);
  const hasVideo = /[?&]v=/.test(url) || /youtu\.be\//.test(url);
  return hasList && !hasVideo;
}

// ======================
// DOWNLOAD E PROCESSAMENTO DE ÁUDIO
// ======================

async function downloadAudio(url, outputPath, guildId) {
  if (fs.existsSync(outputPath)) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const startDownload = () => {
      activeDownloads++;
      console.log(`🎶 Baixando: ${url}`);

      // Garante que o yt-dlp não baixe playlist inteira aqui (se for vídeo único)
      const ytDlp = spawn("yt-dlp", [
        "-x",
        "--audio-format",
        "mp3",
        "--no-playlist",
        "-o",
        outputPath,
        url,
      ]);

      ytDlp.stderr.on("data", (data) => process.stderr.write(data));
      ytDlp.on("close", () => {
        activeDownloads--;
        processQueue(guildId);

        if (fs.existsSync(outputPath)) {
          console.log(`✅ Download concluído: ${outputPath}`);
          resolve();
        } else {
          reject(new Error(`Erro: arquivo não encontrado após download (${outputPath})`));
        }
      });

      ytDlp.on("error", (err) => {
        activeDownloads--;
        processQueue(guildId);
        reject(err);
      });
    };

    if (activeDownloads < MAX_PARALLEL_DOWNLOADS) startDownload();
    else {
      if (!pendingDownloads.has(guildId)) pendingDownloads.set(guildId, []);
      pendingDownloads.get(guildId).push(startDownload);
    }
  });
}

function processQueue(guildId) {
  if (pendingDownloads.has(guildId)) {
    const queue = pendingDownloads.get(guildId);
    if (queue.length > 0 && activeDownloads < MAX_PARALLEL_DOWNLOADS) {
      const next = queue.shift();
      next();
    }
  }
}

// ======================
// CACHE
// ======================

function setupCacheCleanup() {
  setInterval(() => {
    if (!fs.existsSync(cacheDir)) return;
    const files = fs.readdirSync(cacheDir);
    const now = Date.now();
    files.forEach((file) => {
      const filePath = path.join(cacheDir, file);
      try {
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > CACHE_DURATION) fs.unlinkSync(filePath);
      } catch {}
    });
  }, 60 * 60 * 1000);
}

function clearGuildCache(guildId) {
  if (!fs.existsSync(cacheDir)) return;
  if (pendingDownloads.has(guildId)) {
    pendingDownloads.get(guildId).length = 0; // limpa fila de downloads pendentes
    pendingDownloads.delete(guildId);
  }

  const queue = queues.get(guildId);
  const keepFiles = new Set();

  if (queue?.current) keepFiles.add(`VIDEOID-${queue.current.id}.mp3`);
  queue?.tracks.slice(0, 3).forEach((t) => keepFiles.add(`VIDEOID-${t.id}.mp3`));

  for (const file of fs.readdirSync(cacheDir)) {
    if (file.startsWith("VIDEOID-") && !keepFiles.has(file)) {
      try {
        fs.rmSync(path.join(cacheDir, file), { force: true });
      } catch {}
    }
  }
  console.log(`🗑️ Cache da guild ${guildId} limpo (mantidos ${keepFiles.size} arquivos)!`);
}

// ======================
// EXTRAI PLAYLIST
// ======================
function extractPlaylist(url) {
  try {
    const output = execSync(
      `yt-dlp --flat-playlist --get-title --get-id -i "${url}"`
    ).toString();
    const lines = output.trim().split("\n");
    const tracks = [];
    for (let i = 0; i < lines.length; i += 2) {
      const title = lines[i]?.trim() || `Música ${i / 2 + 1}`;
      const id = lines[i + 1]?.trim();
      if (id) tracks.push({ id, url: `https://www.youtube.com/watch?v=${id}`, title });
    }
    return tracks;
  } catch {
    return [];
  }
}

// ======================
// RESOLVE VÍDEO ÚNICO (robusto + busca por nome)
// ======================
function resolveSingleVideo(input) {
  const directId = getVideoIdFromUrl(input);

  try {
    if (directId) {
      // link de vídeo direto
      const title = execSync(`yt-dlp --no-playlist --get-title -i "${input}"`)
        .toString()
        .trim();
      return [{ id: directId, url: input, title }];
    }

    // não é link → busca no YouTube
    const out = execSync(`yt-dlp "ytsearch1:${input}" --get-title --get-id -i`)
      .toString()
      .trim()
      .split("\n");
    if (out.length >= 2) {
      const title = out[0];
      const id = out[1];
      return [{ id, url: `https://www.youtube.com/watch?v=${id}`, title }];
    }
  } catch (e) {
    console.error("resolveSingleVideo erro:", e?.message || e);
  }

  return [];
}

// ======================
// MINI PLAYER
// ======================
async function updatePlayerMessage(guildId) {
  const queue = queues.get(guildId);
  if (!queue) return;

  const current = queue.current;
  const nextTracks = queue.tracks.slice(0, 5);

  let description = "";
  if (current) description += `🎶 **${current.title}**\n\n`;
  if (nextTracks.length) {
    description += "🔜 **Próximas:**\n";
    nextTracks.forEach((t, i) => {
      description += `${i + 1}. ${t.title}\n`;
    });
  }

  const embed = new EmbedBuilder()
    .setTitle("🎵 Fila de Reprodução")
    .setDescription(description || "Fila vazia")
    .setColor(0x1db954);

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("back").setLabel("⬅️ Back").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("resume").setLabel("▶️ Resume").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("pause").setLabel("⏸ Pause").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("skip").setLabel("⏭ Next").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("stop").setLabel("⏹ Stop").setStyle(ButtonStyle.Danger),
  );

  const buttons2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("download").setLabel("⬇️ Download").setStyle(ButtonStyle.Secondary),
  );

  try {
    if (queue.message) {
      // tenta editar; se a mensagem foi deletada, cai no catch
      await queue.message.edit({ embeds: [embed], components: [buttons, buttons2] });
    } else if (queue.textChannel) {
      queue.message = await queue.textChannel.send({ embeds: [embed], components: [buttons, buttons2] });
    }
  } catch (err) {
    // Mensagem foi apagada ou não é mais acessível -> recria
    console.warn("⚠️ Mensagem antiga do player perdida, criando nova...");
    if (queue.textChannel) {
      try {
        queue.message = await queue.textChannel.send({ embeds: [embed], components: [buttons, buttons2] });
      } catch (sendErr) {
        console.error("❌ Falha ao recriar mensagem do player:", sendErr);
      }
    }
  }
}

// ======================
// TOCAR PRÓXIMA
// ======================
async function playNext(guildId, isBack = false) {
  const queue = queues.get(guildId);
  if (!queue) return;

  if (!isBack && queue.tracks.length === 0) {
    queue.player.stop();
    queue.connection?.destroy();
    queue.connection = null;
    if (queue.message) {
      await queue.message.delete().catch(() => {});
      queue.message = null;
    }
    clearGuildCache(guildId);
    queue.playing = false;
    return;
  }

  let track;
  if (isBack && queue.previous.length) {
    track = queue.previous.pop();
    if (queue.current) queue.tracks.unshift(queue.current);
  } else {
    track = queue.tracks.shift();
    if (queue.current) queue.previous.push(queue.current);
  }

  if (!track) return;
  queue.current = track;

  const filePath = path.join(cacheDir, `VIDEOID-${track.id}.mp3`);

  try {
    await downloadAudio(track.url, filePath, guildId);
  } catch (err) {
    console.error("Erro no download:", err);
    return playNext(guildId);
  }

  const resource = createAudioResource(filePath, { inputType: StreamType.Arbitrary });
  queue.player.play(resource);
  queue.connection?.subscribe(queue.player);
  queue.playing = true;

  updatePlayerMessage(guildId);

  // Pré-baixa as próximas
  queue.tracks.slice(0, 3).forEach((t) => {
    const fp = path.join(cacheDir, `VIDEOID-${t.id}.mp3`);
    downloadAudio(t.url, fp, guildId).catch(() => {});
  });

  queue.player.once(AudioPlayerStatus.Idle, () => playNext(guildId));
}

// ======================
// PLAYER EVENTS
// ======================
function setupPlayerEvents(guildId) {
  const queue = queues.get(guildId);
  if (!queue) return;

  queue.player.on("error", (err) => {
    console.error("Player error:", err);
    queue.connection?.destroy();
    queue.connection = null;
    if (queue.message) queue.message.delete().catch(() => {});
    clearGuildCache(guildId);
    queues.delete(guildId);
  });

  queue.connection?.on("error", (err) => {
    console.error("Connection error:", err);
    queue.connection?.destroy();
    queue.connection = null;
    if (queue.message) queue.message.delete().catch(() => {});
    clearGuildCache(guildId);
    queues.delete(guildId);
  });
}

// ======================
// SLASH COMMANDS
// ======================

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Toca música ou playlist do YouTube")
    .addStringOption((opt) =>
      opt.setName("url").setDescription("Link do YouTube").setRequired(true)
    ),
  new SlashCommandBuilder().setName("pause").setDescription("Pausa a música"),
  new SlashCommandBuilder().setName("resume").setDescription("Continua a música"),
  new SlashCommandBuilder().setName("skip").setDescription("Pula a música"),
  new SlashCommandBuilder().setName("stop").setDescription("Para a música e limpa a fila"),
  new SlashCommandBuilder().setName("back").setDescription("Volta para a música anterior"),
];

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    console.log("⌛ Registrando comandos...");
    for (const guildId of GUILD_IDS) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), {
        body: commands.map((c) => c.toJSON()),
      });
      console.log(`✅ Comandos registrados no servidor ${guildId}`);
    }
  } catch (err) {
    console.error(err);
  }
})();

// ======================
// INTERAÇÕES
// ======================

client.on("interactionCreate", async (interaction) => {
  const guildId = interaction.guildId;
  if (!guildId) return;

  if (!queues.has(guildId)) {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Stop },
    });
    queues.set(guildId, {
      tracks: [],
      previous: [],
      current: null,
      player,
      connection: null,
      playing: false,
      message: null,
      textChannel: null,
    });
    setupPlayerEvents(guildId);
  }

  const queue = queues.get(guildId);

  // -------- BOTÕES --------
  if (interaction.isButton()) {
    try {
      switch (interaction.customId) {
        case "pause":
          queue.player.pause();
          break;
        case "resume":
          queue.player.unpause();
          break;
        case "skip":
          playNext(guildId);
          break;
        case "stop":
          queue.tracks = [];
          queue.previous = [];
          queue.player.stop();
          queue.connection?.destroy();
          queue.connection = null;
          if (queue.message) queue.message.delete().catch(() => {});
          queue.message = null;
          clearGuildCache(guildId);
          if (!interaction.replied)
            await interaction.reply({
              content: "⏹ Reprodução parada e fila limpa!",
              flags: MessageFlags.Ephemeral,
            });
          return;
        case "back":
          if (queue.previous.length) {
            playNext(guildId, true);
            if (!interaction.replied)
              await interaction.reply({
                content: "⬅️ Voltando para a música anterior!",
                flags: MessageFlags.Ephemeral,
              });
          } else if (!interaction.replied)
            await interaction.reply({
              content: "❌ Não há música anterior.",
              flags: MessageFlags.Ephemeral,
            });
          return;
        case "download":
          if (queue.current) {
            const filePath = path.join(cacheDir, `VIDEOID-${queue.current.id}.mp3`);
            if (fs.existsSync(filePath)) {
              try {
                await interaction.reply({
                  content: `⬇️ Download da música: **${queue.current.title}**`,
                  files: [filePath],
                });
              } catch (err) {
                await interaction.reply({
                  content:
                    "❌ Não foi possível enviar o arquivo (provavelmente ultrapassa o limite de upload do servidor/Discord).",
                  flags: MessageFlags.Ephemeral,
                });
              }
            } else {
              await interaction.reply({
                content: "❌ Arquivo não encontrado no cache.",
                flags: MessageFlags.Ephemeral,
              });
            }
          } else {
            await interaction.reply({
              content: "❌ Nenhuma música em reprodução.",
              flags: MessageFlags.Ephemeral,
            });
          }
          return;
      }
      if (!interaction.replied && !interaction.deferred)
        await interaction.deferUpdate();
    } catch (err) {
      console.error("Erro no botão:", err);
    }
    return;
  }


  // -------- SLASH COMMANDS --------


  if (!interaction.isChatInputCommand()) return;

  const member = interaction.guild.members.cache.get(interaction.user.id);
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel)
    return interaction.reply({
      content: "❌ Você precisa estar em um canal de voz.",
      flags: MessageFlags.Ephemeral,
    });

  const cmd = interaction.commandName;

  if (cmd === "play") {
    // IMPORTANT: defer reply immediately to avoid "Unknown interaction" while we call yt-dlp/execSync
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (err) {
      // ignore if already deferred/replied
    }

    const url = interaction.options.getString("url");

    // salva canal de texto onde o comando foi chamado
    queue.textChannel = interaction.channel;

    let newTracks = [];

    if (isPurePlaylistUrl(url)) {
      // playlist completa (sem v=)
      newTracks = extractPlaylist(url);
    } else {
      // vídeo único (mesmo que a URL tenha list=)
      newTracks = resolveSingleVideo(url);
    }

    if (!newTracks.length) {
      return interaction.editReply({
        content:
          "❌ Não foi possível identificar o vídeo/playlist. Verifique a URL.",
      });
    }

    queue.tracks.push(...newTracks);

    if (!queue.connection) {
      queue.connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      });
    }

    if (!queue.playing) playNext(guildId);

    return interaction.editReply({ content: `➕ Adicionado ${newTracks.length} música(s) à fila.` });
  }

  if (cmd === "pause") {
    queue.player.pause();
    if (!interaction.replied)
      await interaction.reply({
        content: "⏸ Música pausada!",
        flags: MessageFlags.Ephemeral,
      });
  }
  if (cmd === "resume") {
    queue.player.unpause();
    if (!interaction.replied)
      await interaction.reply({
        content: "▶️ Música retomada!",
        flags: MessageFlags.Ephemeral,
      });
  }
  if (cmd === "skip") {
    playNext(guildId);
    if (!interaction.replied)
      await interaction.reply({
        content: "⏭ Música pulada!",
        flags: MessageFlags.Ephemeral,
      });
  }
  if (cmd === "stop") {
    queue.tracks = [];
    queue.previous = [];
    queue.player.stop();
    queue.connection?.destroy();
    queue.connection = null;
    if (queue.message) queue.message.delete().catch(() => {});
    queue.message = null;
    clearGuildCache(guildId);
    if (!interaction.replied)
      await interaction.reply({
        content: "⏹ Reprodução parada e fila limpa!",
        flags: MessageFlags.Ephemeral,
      });
  }
  if (cmd === "back") {
    if (queue.previous.length) {
      playNext(guildId, true);
      if (!interaction.replied)
        await interaction.reply({
          content: "⬅️ Voltando para a música anterior!",
          flags: MessageFlags.Ephemeral,
        });
    } else if (!interaction.replied)
      await interaction.reply({
        content: "❌ Não há música anterior.",
        flags: MessageFlags.Ephemeral,
      });
  }
});

// ======================
// READY
// ======================

client.once("ready", () => {
  console.log(`🤖 Bot conectado: ${client.user.tag}`);
  setupCacheCleanup();
});
client.login(TOKEN);
