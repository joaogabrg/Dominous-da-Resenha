const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

function createDeck() {
    const deck = [];
    for (let i = 0; i <= 6; i++) {
        for (let j = i; j <= 6; j++) {
            deck.push([i, j]);
        }
    }
    return deck;
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function getHandPips(hand) {
    return hand.reduce((acc, tile) => acc + tile[0] + tile[1], 0);
}

function canPlayTile(tile, leftEnd, rightEnd) {
    if (leftEnd === null && rightEnd === null) return true;
    return tile[0] === leftEnd || tile[1] === leftEnd || tile[0] === rightEnd || tile[1] === rightEnd;
}

function playerHasValidMove(hand, leftEnd, rightEnd) {
    if (leftEnd === null && rightEnd === null) return true;
    return hand.some(tile => canPlayTile(tile, leftEnd, rightEnd));
}

// Encontra o jogador possuidor do Camburão de 6 ([6,6]) ou maior bucha
function findStartingPlayer(players) {
    for (let i = 0; i < players.length; i++) {
        if (players[i] && players[i].hand.some(t => t[0] === 6 && t[1] === 6)) {
            return i;
        }
    }
    let highestDouble = -1;
    let startingPlayer = 0;
    players.forEach((p, pIdx) => {
        if (!p) return;
        p.hand.forEach(tile => {
            if (tile[0] === tile[1] && tile[0] > highestDouble) {
                highestDouble = tile[0];
                startingPlayer = pIdx;
            }
        });
    });
    return startingPlayer;
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {

    socket.on('join_room', ({ roomCode, password, username }) => {
        let room = rooms.get(roomCode);

        if (!room) {
            room = {
                code: roomCode,
                password: password,
                players: [null, null, null, null],
                scores: [0, 0],
                board: [],
                leftEnd: null,
                rightEnd: null,
                turn: 0,
                status: 'lobby',
                nextRoundMultiplier: 1,
                mustStartDoubleSix: false,
                consecutivePasses: 0
            };
            rooms.set(roomCode, room);
        } else if (room.password !== password) {
            return socket.emit('error_msg', 'Senha incorreta para esta sala!');
        }

        socket.join(roomCode);
        socket.emit('joined_room', { roomCode, seats: room.players.map(p => p ? { name: p.name } : null) });
    });

    socket.on('select_seat', ({ roomCode, seatIndex }) => {
        const room = rooms.get(roomCode);
        if (!room || room.players[seatIndex] !== null) return;

        room.players[seatIndex] = {
            id: socket.id,
            name: socket.username || `Jogador ${seatIndex + 1}`,
            hand: [],
            seat: seatIndex
        };

        io.to(roomCode).emit('seats_update', room.players.map(p => p ? { name: p.name } : null));

        if (room.players.every(p => p !== null) && room.status === 'lobby') {
            startNewRound(room, true);
        }
    });

    socket.on('play_tile', ({ roomCode, tileIndex, side }) => {
        const room = rooms.get(roomCode);
        if (!room || room.status !== 'playing') return;

        const playerIndex = room.players.findIndex(p => p && p.id === socket.id);
        if (playerIndex !== room.turn) return;

        const player = room.players[playerIndex];
        const tile = player.hand[tileIndex];

        if (!tile) return;

        // Regra "NAS DUAS"
        let isNasDuas = false;
        if (player.hand.length === 1 && room.leftEnd !== null && room.rightEnd !== null) {
            const fitsLeft = tile[0] === room.leftEnd || tile[1] === room.leftEnd;
            const fitsRight = tile[0] === room.rightEnd || tile[1] === room.rightEnd;
            if (fitsLeft && fitsRight) {
                isNasDuas = true;
            }
        }

        player.hand.splice(tileIndex, 1);

        if (room.board.length === 0) {
            room.board.push(tile);
            room.leftEnd = tile[0];
            room.rightEnd = tile[1];
        } else if (side === 'left') {
            if (tile[1] === room.leftEnd) {
                room.board.unshift(tile);
                room.leftEnd = tile[0];
            } else {
                room.board.unshift([tile[1], tile[0]]);
                room.leftEnd = tile[1];
            }
        } else {
            if (tile[0] === room.rightEnd) {
                room.board.push(tile);
                room.rightEnd = tile[1];
            } else {
                room.board.push([tile[1], tile[0]]);
                room.rightEnd = tile[0];
            }
        }

        room.consecutivePasses = 0;

        if (player.hand.length === 0) {
            const winningTeam = playerIndex % 2;
            let pointsAwarded = isNasDuas ? 2 : 1;
            pointsAwarded *= room.nextRoundMultiplier;

            room.scores[winningTeam] += pointsAwarded;

            let msg = `Dupla ${winningTeam === 0 ? 'A' : 'B'} venceu a rodada (+${pointsAwarded} pts)!`;
            if (isNasDuas) msg = `🔥 JOGADA "NAS DUAS"! Dupla ${winningTeam === 0 ? 'A' : 'B'} ganhou +${pointsAwarded} pts!`;
            io.to(roomCode).emit('special_event', msg);

            room.nextRoundMultiplier = 1;

            if (checkMatchWinner(room)) return;
            startNewRound(room, false);
            return;
        }

        advanceTurn(room);
    });

    socket.on('disconnect', () => {});
});

function advanceTurn(room) {
    let nextTurn = (room.turn + 1) % 4;
    let passes = 0;

    while (!playerHasValidMove(room.players[nextTurn].hand, room.leftEnd, room.rightEnd) && passes < 4) {
        nextTurn = (nextTurn + 1) % 4;
        passes++;
    }

    if (passes >= 4) {
        handleLockedGame(room);
    } else {
        room.turn = nextTurn;
        broadcastGameState(room);
    }
}

function handleLockedGame(room) {
    // Nenhuma dupla pontua quando fecha o jogo. Apenas dobra a próxima rodada.
    room.nextRoundMultiplier = 2;
    room.mustStartDoubleSix = true; // Força início com camburão de 6 na rodada dobrada

    io.to(room.code).emit('special_event', '🔒 Jogo Fechado! Nenhuma dupla pontua. A PRÓXIMA RODADA VALERÁ O DOBRO!');

    if (checkMatchWinner(room)) return;
    startNewRound(room, false);
}

function checkMatchWinner(room) {
    if (room.scores[0] >= 4 || room.scores[1] >= 4) {
        const winner = room.scores[0] >= 4 ? 'A' : 'B';
        io.to(room.code).emit('special_event', `🏆 DUPLA ${winner} VENCEU A PARTIDA!`);
        room.status = 'finished';
        broadcastGameState(room);
        return true;
    }
    return false;
}

function startNewRound(room, isFirstRound) {
    const deck = shuffle(createDeck());
    room.board = [];
    room.leftEnd = null;
    room.rightEnd = null;
    room.status = 'playing';

    room.players.forEach((player, i) => {
        player.hand = deck.slice(i * 7, (i + 1) * 7);
    });

    // Começa com [6,6] se for primeira rodada OU se for rodada pós-jogo fechado (dobrada)
    if (isFirstRound || room.mustStartDoubleSix) {
        room.turn = findStartingPlayer(room.players);
        room.mustStartDoubleSix = false;
    } else {
        room.turn = (room.turn + 1) % 4;
    }

    broadcastGameState(room);
}

function broadcastGameState(room) {
    room.players.forEach((p) => {
        if (!p) return;
        io.to(p.id).emit('game_update', {
            scores: room.scores,
            board: room.board,
            leftEnd: room.leftEnd,
            rightEnd: room.rightEnd,
            turn: room.turn,
            status: room.status,
            nextRoundMultiplier: room.nextRoundMultiplier,
            myHand: p.hand,
            players: room.players.map(pl => pl ? { name: pl.name, handCount: pl.hand.length } : null)
        });
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
});