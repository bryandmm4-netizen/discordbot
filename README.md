node.mjs - use como nome do arquivo;
audio player for discord com: yt-dlp; discord.py; ffmpeg;

codigo feito como um "passa tempo";
existem alguns problemas com o player que esta se perdendo apos algumas musicas tocadas;
ele corta uma musica no meio e pula para a proxima, 
estou tentando resolver, mas com pouco tempo para fazer;


é preciso instalar algumas coisas para usar:
npm install discord.js @discordjs/voice dotenv
npm install ytdl-core ytpl yt-search
----------
yt-dlp: https://github.com/yt-dlp/yt-dlp/releases/latest
Salve como yt-dlp.exe em uma pasta no PATH (por exemplo: C:\Windows\System32) 
ou deixe na mesma pasta do "index.mjs";
ffmpeg: https://ffmpeg.org
---------
Precisa de um arquivo com o exato nome ".env" junto na pasta; 
Nele tem a chave do bot e precisa colocar tambem o ID do servidor para ser utilizado;
Pretendo remover essa limitação de ID por servidor, mas nao agora; 
O .env e um outro arquivo eu editei e vou colocar um exemplo logo;
-----------
Tudo isso precisa ser instalado e feito na pasta do bot;
por exemplo: C:\meu_bot_discord\ ; 
Para os teste eu utilizei um CMD para iniciar dessa pasta
Então no CMD: "cd C:\meu_bot_discord" e depois "node index.mjs"
---------
para burlar o problema do bot tocar uma musica do youtube eu fiz ele tocar um audio baixado convertido de wedm para mp3;
entao ele baixa e toca direto do aparelho, salvando temporariamente esses audios em uma pasta C:\meu_bot_discord\CACHE;
---------
se conseguir arrumar, poderia comentar essa correção?
é livre para usar ele como quiser, só deixa referenciado quem editar;
eu não sou muito organizado e o TDAH nao ajuda, espero que entenda como esse código funiona;
ATT: Bryandmm (criador);
