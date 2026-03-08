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
        userId: p.userId,
        name: p.name,
        score: p.score,
        hasVoted: !!room.votes[p.userId],
        connected: p.connected
    }));
    io.to(roomCode).emit('updateSidebar', sidebarData);
}

function processResults(roomCode) {
    const room = games[roomCode];
    room.state = 'results';

    const undercover = room.players.find(p => p.role === 'Undercover');
    const civil = room.players.find(p => p.role === 'Civil');

    const roundScores = {};
    room.players.forEach(p => roundScores[p.userId] = 0);

    const voteRecap = [];

    for (const [voterId, votedId] of Object.entries(room.votes)) {
        const voter = room.players.find(p => p.userId === voterId);
        const voted = room.players.find(p => p.userId === votedId);

        voteRecap.push({ voterName: voter.name, votedName: voted ? voted.name : "Personne" });

        if (voterId === undercover.userId) continue;

        if (votedId === undercover.userId) {
            roundScores[voterId] += 10;
            voter.score += 10;
        } else {
            roundScores[undercover.userId] += 10;
            undercover.score += 10;
        }
    }

    room.lastResults = {
        undercoverName: undercover.name,
        undercoverWord: undercover.word,
        civilWord: civil ? civil.word : "Inconnu",
        voteRecap: voteRecap,
        roundScores: roundScores,
        players: room.players
    };

    io.to(roomCode).emit('resultsRevealed', room.lastResults);
    broadcastSidebar(roomCode);
}

// Gère la soumission d'un mot (manuel ou forcé par le timer)
function handleClueSubmission(roomCode, expectedUserId, clueText) {
    const room = games[roomCode];
    if (!room || room.state !== 'playing') return;

    const expectedPlayer = room.turnOrder[room.currentTurnIndex];
    if (expectedPlayer.userId !== expectedUserId) return;

    // On efface le timer pour ne pas qu'il s'active en double
    clearTimeout(room.turnTimer);

    room.clues.push({ playerName: expectedPlayer.name, word: clueText });
    room.currentTurnIndex++;

    if (room.currentTurnIndex >= room.turnOrder.length) {
        room.currentTurnIndex = 0;
        room.currentCycle++;
    }

    if (room.currentCycle > room.settings.wordsPerPerson) {
        room.state = 'waiting_for_vote';
        io.to(roomCode).emit('endOfRounds', room.clues);
        broadcastSidebar(roomCode);
    } else {
        const nextPlayer = room.turnOrder[room.currentTurnIndex];
        room.turnEndTime = Date.now() + 30000; // 30 secondes

        // On lance le timer pour le prochain joueur
        room.turnTimer = setTimeout(() => {
            handleClueSubmission(roomCode, nextPlayer.userId, "⏳ TROP LENT");
        }, 30000);

        io.to(roomCode).emit('nextTurn', {
            clues: room.clues,
            currentPlayerId: nextPlayer.userId,
            currentPlayerName: nextPlayer.name,
            currentCycle: room.currentCycle,
            turnEndTime: room.turnEndTime
        });
    }
}

function startNewRound(roomCode) {
    const room = games[roomCode];
    room.state = 'playing';
    room.currentTurnIndex = 0;
    room.currentCycle = 1;
    room.clues = [];
    room.votes = {};
    clearTimeout(room.turnTimer);

    let pool = [];
    if (room.settings.theme === 'Anime') pool = wordPairsDatabase['Anime'];
    else if (room.settings.theme === 'Classique') pool = wordPairsDatabase['Classique'];
    else pool = [...wordPairsDatabase['Classique'], ...wordPairsDatabase['Anime']];

    let availableWords = pool.filter(pair => !room.usedWords.includes(pair.civil));
    if (availableWords.length === 0) {
        room.usedWords = [];
        availableWords = pool;
    }

    const randomIndex = Math.floor(Math.random() * availableWords.length);
    const randomPair = availableWords[randomIndex];

    room.usedWords.push(randomPair.civil);
    if (room.usedWords.length > 20) room.usedWords.shift();

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

        io.to(player.socketId).emit('gameStarted', {
            word: player.word,
            turnOrder: room.turnOrder.map(p => p.name),
            currentPlayerId: room.turnOrder[0].userId,
            currentPlayerName: room.turnOrder[0].name,
            currentRound: room.currentRound,
            totalRounds: room.settings.totalRounds,
            wordsPerPerson: room.settings.wordsPerPerson,
            turnEndTime: Date.now() + 30000 // Fin du premier tour dans 30s
        });
    });

    // Lancer le timer pour le 1er joueur
    room.turnTimer = setTimeout(() => {
        handleClueSubmission(roomCode, room.turnOrder[0].userId, "⏳ TROP LENT");
    }, 30000);

    broadcastSidebar(roomCode);
}

io.on('connection', (socket) => {

    // --- RECONNEXION AUTOMATIQUE ---
    socket.on('reconnectUser', (data) => {
        const room = games[data.roomCode];
        if (room) {
            const player = room.players.find(p => p.userId === data.userId);
            if (player) {
                player.socketId = socket.id;
                player.connected = true;
                socket.join(data.roomCode);

                socket.emit('reconnectSuccess', {
                    roomCode: data.roomCode,
                    room: room,
                    myUserId: data.userId
                });
                broadcastSidebar(data.roomCode);
                return;
            }
        }
        socket.emit('reconnectFailed');
    });

    socket.on('createRoom', (data) => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();

        games[roomCode] = {
            code: roomCode,
            players: [{ userId: data.userId, socketId: socket.id, name: data.playerName, role: null, word: null, score: 0, connected: true }],
            state: 'waiting',
            settings: {
                wordsPerPerson: parseInt(data.wordsPerPerson) || 2,
                totalRounds: parseInt(data.totalRounds) || 1,
                theme: data.theme || 'Mixte'
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
        const room = games[roomCode];

        if (room && room.state === 'waiting') {
            const existing = room.players.find(p => p.userId === data.userId);
            if (!existing) {
                room.players.push({ userId: data.userId, socketId: socket.id, name: data.playerName, role: null, word: null, score: 0, connected: true });
            }
            socket.join(roomCode);
            socket.emit('roomJoined', roomCode);
            broadcastSidebar(roomCode);
        } else {
            socket.emit('error', 'Salon introuvable ou partie en cours.');
        }
    });

    // QUITTER LE SALON DÉFINITIVEMENT
    socket.on('leaveRoom', (data) => {
        const room = games[data.roomCode];
        if (room) {
            const playerIndex = room.players.findIndex(p => p.userId === data.userId);
            if (playerIndex !== -1) {
                room.players.splice(playerIndex, 1);
                socket.leave(data.roomCode);
                broadcastSidebar(data.roomCode);
                if (room.players.length === 0) delete games[data.roomCode];
            }
        }
    });

    socket.on('startGame', (data) => {
        const room = games[data.roomCode];
        if (room && room.state === 'waiting' && room.players[0].userId === data.userId) {
            if (room.players.length < 3) return socket.emit('error', "3 joueurs minimum requis.");
            startNewRound(data.roomCode);
        }
    });

    socket.on('submitClue', (data) => {
        handleClueSubmission(data.roomCode, data.userId, data.clue);
    });

    socket.on('hostStartVote', (data) => {
        const room = games[data.roomCode];
        if (room && room.state === 'waiting_for_vote' && room.players[0].userId === data.userId) {
            room.state = 'voting';
            const playersToVoteFor = room.players.map(p => ({ userId: p.userId, name: p.name }));
            io.to(data.roomCode).emit('votePhase', { players: playersToVoteFor, clues: room.clues });
            broadcastSidebar(data.roomCode);
        }
    });

    socket.on('submitVote', (data) => {
        const room = games[data.roomCode];
        if (room && room.state === 'voting' && !room.votes[data.userId]) {
            room.votes[data.userId] = data.votedId;
            broadcastSidebar(data.roomCode);

            // Vérifier si tous les joueurs CONNECTÉS ont voté
            const connectedPlayers = room.players.filter(p => p.connected);
            const allVoted = connectedPlayers.every(p => room.votes[p.userId] !== undefined);

            if (allVoted && connectedPlayers.length > 0) {
                processResults(data.roomCode);
            }
        }
    });

    socket.on('nextRound', (data) => {
        const room = games[data.roomCode];
        if (room && room.players[0].userId === data.userId) {
            room.currentRound++;
            if (room.currentRound > room.settings.totalRounds) {
                io.to(data.roomCode).emit('gameOver');
            } else {
                startNewRound(data.roomCode);
            }
        }
    });

    socket.on('disconnect', () => {
        for (const code in games) {
            const room = games[code];
            const player = room.players.find(p => p.socketId === socket.id);
            if (player) {
                player.connected = false;
                broadcastSidebar(code);

                if (room.state === 'voting') {
                    const connectedPlayers = room.players.filter(p => p.connected);
                    const allVoted = connectedPlayers.every(p => room.votes[p.userId] !== undefined);
                    if (allVoted && connectedPlayers.length > 0) {
                        processResults(code);
                    }
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur en ligne : http://localhost:${PORT}`));