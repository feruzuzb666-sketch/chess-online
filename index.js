const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── MA'LUMOTLAR ─────────────────────────────────────────────
const users = new Map();       // username -> { socketId, username, rating, online }
const games = new Map();       // gameId -> { white, black, board, moves, ... }
const invites = new Map();     // inviteId -> { from, to, timeControl, color, timestamp }
const messages = new Map();    // username -> [{ from, text, timestamp }]

// ─── YORDAMCHI FUNKSIYALAR ──────────────────────────────────
function getUserBySocket(socketId) {
  for (const [uname, user] of users) {
    if (user.socketId === socketId) return user;
  }
  return null;
}

function broadcastUserList() {
  const onlineUsers = Array.from(users.values())
    .filter(u => u.online)
    .map(u => ({ username: u.username, rating: u.rating }));
  io.emit('user_list', onlineUsers);
}

// ─── SOCKET.IO ──────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Yangi ulanish:', socket.id);

  // LOGIN
  socket.on('login', ({ username }) => {
    if (!username || username.length < 2 || username.length > 20) {
      socket.emit('login_error', 'Foydalanuvchi nomi 2-20 ta belgi bo\'lishi kerak');
      return;
    }
    const clean = username.trim().replace(/[^a-zA-Z0-9_\u0400-\u04FF]/g, '');
    if (!clean) {
      socket.emit('login_error', 'Noto\'g\'ri nom');
      return;
    }
    // Agar boshqa socket bilan kirgan bo'lsa, uni chiqarib yubor
    if (users.has(clean)) {
      const existing = users.get(clean);
      if (existing.socketId !== socket.id) {
        const oldSocket = io.sockets.sockets.get(existing.socketId);
        if (oldSocket) oldSocket.emit('force_logout', 'Boshqa qurilmadan kirish');
      }
    }
    users.set(clean, {
      socketId: socket.id,
      username: clean,
      rating: users.has(clean) ? users.get(clean).rating : 1200,
      online: true
    });
    socket.username = clean;
    // Pending xabarlarni yubor
    const myMsgs = messages.get(clean) || [];
    socket.emit('login_ok', {
      username: clean,
      rating: users.get(clean).rating,
      pendingMessages: myMsgs
    });
    messages.set(clean, []);
    broadcastUserList();
    console.log(`${clean} kirdi`);
  });

  // FOYDALANUVCHI QIDIRISH
  socket.on('search_user', ({ query }) => {
    if (!socket.username) return;
    const results = Array.from(users.values())
      .filter(u => u.username !== socket.username &&
        u.username.toLowerCase().includes(query.toLowerCase()))
      .map(u => ({ username: u.username, rating: u.rating, online: u.online }));
    socket.emit('search_results', results);
  });

  // XABAR YUBORISH
  socket.on('send_message', ({ to, text }) => {
    if (!socket.username) return;
    if (!text || text.length > 500) return;
    const msg = {
      from: socket.username,
      text: text.trim(),
      timestamp: Date.now()
    };
    const toUser = users.get(to);
    if (toUser && toUser.online) {
      const toSocket = io.sockets.sockets.get(toUser.socketId);
      if (toSocket) toSocket.emit('new_message', msg);
    } else {
      // Offline - saqlap qo'y
      const pending = messages.get(to) || [];
      pending.push(msg);
      messages.set(to, pending);
    }
    // Sender ga tasdiqlash
    socket.emit('message_sent', { to, msg });
  });

  // O'YIN TAKLIFI YUBORISH
  socket.on('send_invite', ({ to, timeControl, myColor }) => {
    if (!socket.username) return;
    const toUser = users.get(to);
    if (!toUser || !toUser.online) {
      socket.emit('invite_error', 'Foydalanuvchi online emas');
      return;
    }
    const inviteId = crypto.randomUUID();
    invites.set(inviteId, {
      id: inviteId,
      from: socket.username,
      to,
      timeControl,   // { minutes, increment }
      myColor,       // 'w' or 'b' (from sender's perspective)
      timestamp: Date.now()
    });
    // 60 soniyada eskiradi
    setTimeout(() => invites.delete(inviteId), 60000);

    const toSocket = io.sockets.sockets.get(toUser.socketId);
    if (toSocket) {
      toSocket.emit('game_invite', {
        inviteId,
        from: socket.username,
        fromRating: users.get(socket.username)?.rating,
        timeControl,
        myColor  // receiver ning rangi teskari
      });
    }
    socket.emit('invite_sent', { inviteId, to });
  });

  // TAKLIFNI QABUL QILISH
  socket.on('accept_invite', ({ inviteId }) => {
    if (!socket.username) return;
    const invite = invites.get(inviteId);
    if (!invite) {
      socket.emit('invite_error', 'Taklif topilmadi yoki eskirdi');
      return;
    }
    invites.delete(inviteId);

    const gameId = crypto.randomUUID();
    // myColor = sender ning rangi; receiver teskari
    const whitePlayer = invite.myColor === 'w' ? invite.from : invite.to;
    const blackPlayer = invite.myColor === 'w' ? invite.to : invite.from;

    const game = {
      id: gameId,
      white: whitePlayer,
      black: blackPlayer,
      timeControl: invite.timeControl,
      startTime: null,
      moves: [],
      clkW: invite.timeControl.minutes * 60,
      clkB: invite.timeControl.minutes * 60,
      lastMoveTime: null,
      status: 'waiting',  // waiting -> countdown -> playing -> ended
      countdownEnd: null
    };
    games.set(gameId, game);

    // Har ikkala o'yinchiga game room ga qo'shish
    const fromUser = users.get(invite.from);
    const fromSocket = io.sockets.sockets.get(fromUser?.socketId);
    if (fromSocket) {
      fromSocket.join(gameId);
      fromSocket.gameId = gameId;
    }
    socket.join(gameId);
    socket.gameId = gameId;

    // 5 soniyalik hisob-kitob
    const countdownEnd = Date.now() + 5000;
    game.countdownEnd = countdownEnd;
    game.status = 'countdown';

    io.to(gameId).emit('game_starting', {
      gameId,
      white: whitePlayer,
      black: blackPlayer,
      timeControl: invite.timeControl,
      countdownEnd
    });

    setTimeout(() => {
      if (games.has(gameId)) {
        game.status = 'playing';
        game.startTime = Date.now();
        game.lastMoveTime = Date.now();
        io.to(gameId).emit('game_started', { gameId });
      }
    }, 5000);
  });

  // TAKLIFNI RAD ETISH
  socket.on('decline_invite', ({ inviteId }) => {
    const invite = invites.get(inviteId);
    if (invite) {
      invites.delete(inviteId);
      const fromUser = users.get(invite.from);
      if (fromUser) {
        const fromSocket = io.sockets.sockets.get(fromUser.socketId);
        if (fromSocket) fromSocket.emit('invite_declined', { by: socket.username });
      }
    }
  });

  // HAMLA YUBORISH
  socket.on('move', ({ gameId, from, to, promotion }) => {
    if (!socket.username) return;
    const game = games.get(gameId);
    if (!game || game.status !== 'playing') return;

    const isWhite = game.white === socket.username;
    const currentColor = game.moves.length % 2 === 0 ? 'w' : 'b';
    if ((isWhite && currentColor !== 'w') || (!isWhite && currentColor !== 'b')) return;

    // Vaqtni hisoblash
    if (game.timeControl.minutes > 0) {
      const elapsed = Math.floor((Date.now() - game.lastMoveTime) / 1000);
      if (currentColor === 'w') {
        game.clkW -= elapsed;
        game.clkW += game.timeControl.increment;
        if (game.clkW <= 0) {
          game.status = 'ended';
          io.to(gameId).emit('game_over', { reason: 'timeout', winner: game.black });
          return;
        }
      } else {
        game.clkB -= elapsed;
        game.clkB += game.timeControl.increment;
        if (game.clkB <= 0) {
          game.status = 'ended';
          io.to(gameId).emit('game_over', { reason: 'timeout', winner: game.white });
          return;
        }
      }
      game.lastMoveTime = Date.now();
    }

    game.moves.push({ from, to, promotion });
    io.to(gameId).emit('opponent_move', {
      from, to, promotion,
      clkW: game.clkW,
      clkB: game.clkB,
      moveNum: game.moves.length
    });
  });

  // O'YIN TUGASH (taslim, durang, shoh mat)
  socket.on('game_result', ({ gameId, reason, winner }) => {
    const game = games.get(gameId);
    if (!game || game.status !== 'playing') return;
    game.status = 'ended';
    io.to(gameId).emit('game_over', { reason, winner });
    // Rating yangilash (oddiy)
    if (winner && reason !== 'draw') {
      const loser = winner === game.white ? game.black : game.white;
      const winUser = users.get(winner);
      const loseUser = users.get(loser);
      if (winUser) winUser.rating += 10;
      if (loseUser) loseUser.rating = Math.max(100, loseUser.rating - 10);
      broadcastUserList();
    }
    setTimeout(() => games.delete(gameId), 60000);
  });

  // ULANISH UZILISH
  socket.on('disconnect', () => {
    const user = getUserBySocket(socket.id);
    if (user) {
      user.online = false;
      // Agar o'yinda bo'lsa
      if (socket.gameId) {
        const game = games.get(socket.gameId);
        if (game && game.status === 'playing') {
          const opponent = game.white === user.username ? game.black : game.white;
          io.to(socket.gameId).emit('game_over', {
            reason: 'disconnect',
            winner: opponent
          });
          game.status = 'ended';
        }
      }
      broadcastUserList();
      console.log(`${user.username} chiqdi`);
    }
  });

  // PING
  socket.on('ping_server', () => socket.emit('pong_server'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server ishlamoqda: http://localhost:${PORT}`));
