const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const wordPairsDatabase = require('./words.json');

const games = {};

function broadcastSidebar(roomCode) {
    const room = games[roomCode];
    if (!room) return;
    const sidebarData = room.players.map(p => ({
        id: p.id,
        name: p.name,
        score: p.score,
        hasVoted: !!room.votes[p.id]
    }));
    io.to(roomCode).emit('updateSidebar', sidebarData);
}

function processResults(roomCode) {
    const room = games[roomCode];
    room.state = 'results';

    const undercover = room.players.find(p => p.role === 'Undercover');
    const civil = room.players.find(p => p.role === 'Civil');

    const roundScores = {};
    room.players.forEach(p => roundScores[p.id] = 0);

    const voteRecap = [];

    for (const [voterId, votedId] of Object.entries(room.votes)) {
        const voter = room.players.find(p => p.id === voterId);
        const voted = room.players.find(p => p.id === votedId);

        voteRecap.push({ voterName: voter.name, votedName: voted ? voted.name : "Personne" });

        if (voterId === undercover.id) continue;

        if (votedId === undercover.id) {
            roundScores[voterId] += 10;
            voter.score += 10;
        } else {
            roundScores[undercover.id] += 10;
            undercover.score += 10;
        }
    }

    io.to(roomCode).emit('resultsRevealed', {
        undercoverName: undercover.name,
        undercoverWord: undercover.word,
        civilWord: civil ? civil.word : "Inconnu",
        voteRecap: voteRecap,
        roundScores: roundScores,
        players: room.players
    });

    broadcastSidebar(roomCode);
}

function startNewRound(roomCode) {
    const room = games[roomCode];
    room.state = 'playing';
    room.currentTurnIndex = 0;
    room.currentCycle = 1;
    room.clues = [];
    room.votes = {};

    // --- SÉLECTION DU THÈME ---
    let pool = [];
    if (room.settings.theme === 'Anime') {
        pool = wordPairsDatabase['Anime'];
    } else if (room.settings.theme === 'Classique') {
        pool = wordPairsDatabase['Classique'];
    } else {
        // Thème Mixte (On mélange les deux)
        pool = [...wordPairsDatabase['Classique'], ...wordPairsDatabase['Anime']];
    }

    // --- SYSTÈME ANTI-DOUBLON ---
    let availableWords = pool.filter(pair => !room.usedWords.includes(pair.civil));

    if (availableWords.length === 0) {
        room.usedWords = [];
        availableWords = pool;
    }

    const randomIndex = Math.floor(Math.random() * availableWords.length);
    const randomPair = availableWords[randomIndex];

    // On mémorise le mot pour ne pas le revoir tout de suite
    room.usedWords.push(randomPair.civil);
    if (room.usedWords.length > 20) {
        room.usedWords.shift();
    }

    const undercoverIndex = Math.floor(Math.random() * room.players.length);
    room.turnOrder = [...room.players].sort(() => Math.random() - 0.5);

    room.players.forEach((player, index) => {
        if (index === undercoverIndex) {
            player.role = 'Undercover';
            player.word = randomPair.undercover;
        } else {
            player.role = 'Civil';
            player.word = randomPair.civil;
        }

        io.to(player.id).emit('gameStarted', {
            word: player.word,
            turnOrder: room.turnOrder.map(p => p.name),
            currentPlayerId: room.turnOrder[0].id,
            currentPlayerName: room.turnOrder[0].name,
            currentRound: room.currentRound,
            totalRounds: room.settings.totalRounds,
            wordsPerPerson: room.settings.wordsPerPerson
        });
    });

    broadcastSidebar(roomCode);
}

io.on('connection', (socket) => {
    socket.on('createRoom', (data) => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();

        games[roomCode] = {
            players: [{ id: socket.id, name: data.playerName, role: null, word: null, score: 0 }],
            state: 'waiting',
            settings: {
                wordsPerPerson: parseInt(data.wordsPerPerson) || 2,
                totalRounds: parseInt(data.totalRounds) || 1,
                theme: data.theme || 'Mixte' // On enregistre le thème !
            },
            currentRound: 1,
            turnOrder: [],
            currentTurnIndex: 0,
            currentCycle: 1,
            clues: [],
            votes: {},
            usedWords: []
        };

        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
        broadcastSidebar(roomCode);
    });

    socket.on('joinRoom', (data) => {
        const roomCode = data.code;
        const playerName = data.playerName;
        const room = games[roomCode];

        if (room && room.state === 'waiting') {
            room.players.push({ id: socket.id, name: playerName, role: null, word: null, score: 0 });
            socket.join(roomCode);
            socket.emit('roomJoined', roomCode);
            broadcastSidebar(roomCode);
        } else {
            socket.emit('error', 'Salon introuvable ou partie en cours.');
        }
    });

    socket.on('startGame', (roomCode) => {
        const room = games[roomCode];
        if (room && room.state === 'waiting' && room.players[0].id === socket.id) {
            if (room.players.length < 3) return socket.emit('error', "3 joueurs minimum requis.");
            startNewRound(roomCode);
        }
    });

    socket.on('submitClue', (data) => {
        const room = games[data.roomCode];
        if (!room || room.state !== 'playing') return;

        const expectedPlayer = room.turnOrder[room.currentTurnIndex];
        if (socket.id !== expectedPlayer.id) return;

        room.clues.push({ playerName: expectedPlayer.name, word: data.clue });
        room.currentTurnIndex++;

        if (room.currentTurnIndex >= room.turnOrder.length) {
            room.currentTurnIndex = 0;
            room.currentCycle++;
        }

        if (room.currentCycle > room.settings.wordsPerPerson) {
            room.state = 'waiting_for_vote';
            io.to(data.roomCode).emit('endOfRounds', room.clues);
            broadcastSidebar(data.roomCode);
        } else {
            const nextPlayer = room.turnOrder[room.currentTurnIndex];
            io.to(data.roomCode).emit('nextTurn', {
                clues: room.clues,
                currentPlayerId: nextPlayer.id,
                currentPlayerName: nextPlayer.name,
                currentCycle: room.currentCycle
            });
        }
    });

    socket.on('hostStartVote', (roomCode) => {
        const room = games[roomCode];
        if (room && room.state === 'waiting_for_vote' && room.players[0].id === socket.id) {
            room.state = 'voting';
            const playersToVoteFor = room.players.map(p => ({ id: p.id, name: p.name }));
            io.to(roomCode).emit('votePhase', { players: playersToVoteFor, clues: room.clues });
            broadcastSidebar(roomCode);
        }
    });

    socket.on('submitVote', (data) => {
        const room = games[data.roomCode];
        if (room && room.state === 'voting' && !room.votes[socket.id]) {
            room.votes[socket.id] = data.votedId;
            broadcastSidebar(data.roomCode);

            const votesCount = Object.keys(room.votes).length;

            if (votesCount === room.players.length) {
                processResults(data.roomCode);
            }
        }
    });

    socket.on('nextRound', (roomCode) => {
        const room = games[roomCode];
        if (room && room.players[0].id === socket.id) {
            room.currentRound++;
            if (room.currentRound > room.settings.totalRounds) {
                io.to(roomCode).emit('gameOver', room.players);
            } else {
                startNewRound(roomCode);
            }
        }
    });

    socket.on('disconnect', () => {
        for (const code in games) {
            const room = games[code];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                room.players.splice(playerIndex, 1);
                broadcastSidebar(code);

                if (room.state === 'voting') {
                    const votesCount = Object.keys(room.votes).length;
                    if (votesCount === room.players.length && room.players.length > 0) {
                        processResults(code);
                    }
                }

                if (room.players.length === 0) delete games[code];
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur en ligne : http://localhost:${PORT}`));

// --- BOT ANTI-SOMMEIL POUR RENDER ---
const https = require('https');

// Le bot s'exécute toutes les 14 minutes (14 * 60 * 1000 millisecondes)
setInterval(() => {
    // Remplacer par l'URL finale que Render va te donner (ex: https://mon-jeu-undercover.onrender.com)
    const url = 'https://TON-APP.onrender.com';

    // On évite de faire le ping si l'URL n'est pas encore configurée
    if (url.includes('TON-APP')) return;

    https.get(url, (res) => {
        console.log(`[Bot] Ping effectué - Le site reste éveillé (Statut: ${res.statusCode})`);
    }).on('error', (e) => {
        console.error(`[Bot] Erreur lors du ping : ${e.message}`);
    });
}, 14 * 60 * 1000);