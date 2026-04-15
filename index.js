const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const users = new Map();
const games = new Map();
const invites = new Map();
const messages = new Map();
const seeks = new Map(); // username -> timeControl
const linkGames = new Map(); // linkId -> { timeControl, color, creator, createdAt }

function getUserBySocket(socketId) {
  for (const [, user] of users) { if (user.socketId === socketId) return user; }
  return null;
}

function broadcastUserList() {
  const list = Array.from(users.values()).filter(u => u.online)
    .map(u => ({ username: u.username, rating: u.rating, online: u.online }));
  io.emit('user_list', list);
}

function broadcastSeekList() {
  const list = Array.from(seeks.entries()).map(([username, tc]) => {
    const u = users.get(username);
    return { username, rating: u ? u.rating : 1200, timeControl: tc };
  });
  io.emit('seek_list', list);
}

io.on('connection', (socket) => {
  socket.on('login', ({ username }) => {
    if (!username || username.length < 2 || username.length > 20) {
      socket.emit('login_error', 'Foydalanuvchi nomi 2-20 ta belgi bo\'lishi kerak'); return;
    }
    const clean = username.trim().replace(/[^a-zA-Z0-9_\u0400-\u04FF]/g, '');
    if (!clean) { socket.emit('login_error', 'Noto\'g\'ri nom'); return; }
    if (users.has(clean)) {
      const existing = users.get(clean);
      if (existing.socketId !== socket.id) {
        const old = io.sockets.sockets.get(existing.socketId);
        if (old) old.emit('force_logout', 'Boshqa qurilmadan kirish');
      }
    }
    const prevRating = users.has(clean) ? users.get(clean).rating : 1200;
    users.set(clean, { socketId: socket.id, username: clean, rating: prevRating, online: true });
    socket.username = clean;
    const myMsgs = messages.get(clean) || [];
    socket.emit('login_ok', { username: clean, rating: prevRating, pendingMessages: myMsgs });
    messages.set(clean, []);
    broadcastUserList();
    broadcastSeekList();
  });

  socket.on('search_user', ({ query }) => {
    if (!socket.username) return;
    const results = Array.from(users.values())
      .filter(u => u.username !== socket.username && u.username.toLowerCase().includes(query.toLowerCase()))
      .map(u => ({ username: u.username, rating: u.rating, online: u.online }));
    socket.emit('search_results', results);
  });

  socket.on('send_message', ({ to, text }) => {
    if (!socket.username || !text || text.length > 500) return;
    const msg = { from: socket.username, text: text.trim(), timestamp: Date.now() };
    const toUser = users.get(to);
    if (toUser && toUser.online) {
      const ts = io.sockets.sockets.get(toUser.socketId);
      if (ts) ts.emit('new_message', msg);
    } else {
      const pending = messages.get(to) || []; pending.push(msg); messages.set(to, pending);
    }
    socket.emit('message_sent', { to, msg });
  });

  // SEEK TIZIMI
  socket.on('publish_seek', ({ timeControl }) => {
    if (!socket.username) return;
    seeks.set(socket.username, timeControl);
    socket.seekTC = timeControl;
    broadcastSeekList();
  });

  socket.on('cancel_seek', () => {
    if (!socket.username) return;
    seeks.delete(socket.username);
    socket.seekTC = null;
    broadcastSeekList();
  });

  socket.on('accept_seek', ({ seekUsername }) => {
    if (!socket.username || !seekUsername) return;
    if (!seeks.has(seekUsername)) { socket.emit('invite_error', 'Bu o\'yin topilmadi'); return; }
    const tc = seeks.get(seekUsername);
    seeks.delete(seekUsername);
    broadcastSeekList();

    const col = Math.random() < 0.5 ? 'w' : 'b';
    const gameId = crypto.randomUUID();
    const white = col === 'w' ? seekUsername : socket.username;
    const black = col === 'w' ? socket.username : seekUsername;
    const game = {
      id: gameId, white, black, timeControl: tc, moves: [],
      clkW: tc.minutes * 60, clkB: tc.minutes * 60,
      lastMoveTime: null, status: 'countdown', countdownEnd: null, drawOffer: null
    };
    games.set(gameId, game);
    const seekUser = users.get(seekUsername);
    const seekSock = io.sockets.sockets.get(seekUser?.socketId);
    if (seekSock) { seekSock.join(gameId); seekSock.gameId = gameId; }
    socket.join(gameId); socket.gameId = gameId;
    const countdownEnd = Date.now() + 5000;
    game.countdownEnd = countdownEnd;
    io.to(gameId).emit('game_starting', { gameId, white, black, timeControl: tc, countdownEnd });
    setTimeout(() => {
      if (games.has(gameId)) {
        game.status = 'playing'; game.startTime = Date.now(); game.lastMoveTime = Date.now();
        io.to(gameId).emit('game_started', { gameId });
      }
    }, 5000);
  });

  socket.on('send_invite', ({ to, timeControl, myColor }) => {
    if (!socket.username) return;
    const toUser = users.get(to);
    if (!toUser || !toUser.online) { socket.emit('invite_error', 'Foydalanuvchi online emas'); return; }
    const inviteId = crypto.randomUUID();
    invites.set(inviteId, { id: inviteId, from: socket.username, to, timeControl, myColor, timestamp: Date.now() });
    setTimeout(() => invites.delete(inviteId), 60000);
    const ts = io.sockets.sockets.get(toUser.socketId);
    if (ts) ts.emit('game_invite', { inviteId, from: socket.username, fromRating: users.get(socket.username)?.rating, timeControl, myColor });
    socket.emit('invite_sent', { inviteId, to });
  });

  socket.on('accept_invite', ({ inviteId }) => {
    if (!socket.username) return;
    const invite = invites.get(inviteId);
    if (!invite) { socket.emit('invite_error', 'Taklif topilmadi yoki eskirdi'); return; }
    invites.delete(inviteId);
    let col = invite.myColor;
    if (col === 'r') col = Math.random() < 0.5 ? 'w' : 'b';
    const gameId = crypto.randomUUID();
    const white = col === 'w' ? invite.from : invite.to;
    const black = col === 'w' ? invite.to : invite.from;
    const game = {
      id: gameId, white, black, timeControl: invite.timeControl, moves: [],
      clkW: invite.timeControl.minutes * 60, clkB: invite.timeControl.minutes * 60,
      lastMoveTime: null, status: 'countdown', countdownEnd: null, drawOffer: null
    };
    games.set(gameId, game);
    const fromUser = users.get(invite.from);
    const fromSock = io.sockets.sockets.get(fromUser?.socketId);
    if (fromSock) { fromSock.join(gameId); fromSock.gameId = gameId; }
    socket.join(gameId); socket.gameId = gameId;
    const countdownEnd = Date.now() + 5000;
    game.countdownEnd = countdownEnd;
    io.to(gameId).emit('game_starting', { gameId, white, black, timeControl: invite.timeControl, countdownEnd });
    setTimeout(() => {
      if (games.has(gameId)) {
        game.status = 'playing'; game.startTime = Date.now(); game.lastMoveTime = Date.now();
        io.to(gameId).emit('game_started', { gameId });
      }
    }, 5000);
  });

  socket.on('decline_invite', ({ inviteId }) => {
    const invite = invites.get(inviteId);
    if (invite) {
      invites.delete(inviteId);
      const fromUser = users.get(invite.from);
      if (fromUser) { const fs = io.sockets.sockets.get(fromUser.socketId); if (fs) fs.emit('invite_declined', { by: socket.username }); }
    }
  });

  // LINK YARATISH (Yangi)
  socket.on('create_link_game', ({ linkId, timeControl, color }) => {
    if (!socket.username) return;
    linkGames.set(linkId, {
      timeControl,
      color,
      creator: socket.username,
      createdAt: Date.now()
    });
    // 1 soatdan keyin o'chirish
    setTimeout(() => linkGames.delete(linkId), 3600000);
    socket.emit('link_game_created', { linkId });
  });

  socket.on('join_link_game', ({ linkId }) => {
    if (!socket.username) return;
    const linkGame = linkGames.get(linkId);
    if (!linkGame) {
      socket.emit('toast_msg', '❌ Havola topilmadi yoki eskirgan');
      return;
    }
    const creator = linkGame.creator;
    if (creator === socket.username) {
      socket.emit('toast_msg', '⚠ O\'zingiz bilan o\'ynay olmaysiz');
      return;
    }
    linkGames.delete(linkId);
    
    let col = linkGame.color;
    if (col === 'r') col = Math.random() < 0.5 ? 'w' : 'b';
    const gameId = crypto.randomUUID();
    const white = col === 'w' ? creator : socket.username;
    const black = col === 'w' ? socket.username : creator;
    const tc = linkGame.timeControl;
    const game = {
      id: gameId, white, black, timeControl: tc, moves: [],
      clkW: tc.minutes * 60, clkB: tc.minutes * 60,
      lastMoveTime: null, status: 'countdown', countdownEnd: null, drawOffer: null
    };
    games.set(gameId, game);
    
    const creatorUser = users.get(creator);
    const creatorSock = io.sockets.sockets.get(creatorUser?.socketId);
    if (creatorSock) { creatorSock.join(gameId); creatorSock.gameId = gameId; }
    socket.join(gameId); socket.gameId = gameId;
    
    const countdownEnd = Date.now() + 5000;
    game.countdownEnd = countdownEnd;
    
    // Ikkala o'yinchiga ham yuborish
    const myColorForJoiner = (white === socket.username) ? 'w' : 'b';
    const myColorForCreator = (white === creator) ? 'w' : 'b';
    
    io.to(gameId).emit('game_starting', { gameId, white, black, timeControl: tc, countdownEnd });
    
    // Qo'shimcha ravishda, client bilishi uchun o'z rangini yuboramiz
    if (creatorSock) {
      creatorSock.emit('link_game_started', { gameId, white, black, timeControl: tc, countdownEnd, myColor: myColorForCreator });
    }
    socket.emit('link_game_started', { gameId, white, black, timeControl: tc, countdownEnd, myColor: myColorForJoiner });
    
    setTimeout(() => {
      if (games.has(gameId)) {
        game.status = 'playing'; game.startTime = Date.now(); game.lastMoveTime = Date.now();
        io.to(gameId).emit('game_started', { gameId });
      }
    }, 5000);
  });

  socket.on('move', ({ gameId, from, to, promotion }) => {
    if (!socket.username) return;
    const game = games.get(gameId);
    if (!game || game.status !== 'playing') return;
    const isWhite = game.white === socket.username;
    const currentColor = game.moves.length % 2 === 0 ? 'w' : 'b';
    if ((isWhite && currentColor !== 'w') || (!isWhite && currentColor !== 'b')) return;
    game.drawOffer = null;
    if (game.timeControl.minutes > 0) {
      const elapsed = Math.floor((Date.now() - game.lastMoveTime) / 1000);
      if (currentColor === 'w') {
        game.clkW = game.clkW - elapsed + game.timeControl.increment;
        if (game.clkW <= 0) { game.clkW = 0; game.status = 'ended'; io.to(gameId).emit('game_over', { reason: 'timeout', winner: game.black }); return; }
      } else {
        game.clkB = game.clkB - elapsed + game.timeControl.increment;
        if (game.clkB <= 0) { game.clkB = 0; game.status = 'ended'; io.to(gameId).emit('game_over', { reason: 'timeout', winner: game.white }); return; }
      }
      game.lastMoveTime = Date.now();
    }
    game.moves.push({ from, to, promotion });
    io.to(gameId).emit('opponent_move', { from, to, promotion, clkW: game.clkW, clkB: game.clkB, moveNum: game.moves.length });
  });

  socket.on('offer_draw', ({ gameId }) => {
    if (!socket.username) return;
    const game = games.get(gameId);
    if (!game || game.status !== 'playing') return;
    if (game.drawOffer === socket.username) { socket.emit('toast_msg', 'Siz allaqachon durang taklif qildingiz'); return; }
    game.drawOffer = socket.username;
    socket.emit('toast_msg', '½ Durang taklifi yuborildi');
    const opp = game.white === socket.username ? game.black : game.white;
    const oppSock = io.sockets.sockets.get(users.get(opp)?.socketId);
    if (oppSock) oppSock.emit('draw_offered', { by: socket.username });
  });

  socket.on('accept_draw', ({ gameId }) => {
    if (!socket.username) return;
    const game = games.get(gameId);
    if (!game || game.status !== 'playing' || !game.drawOffer || game.drawOffer === socket.username) return;
    game.status = 'ended'; game.drawOffer = null;
    io.to(gameId).emit('game_over', { reason: 'draw', winner: null });
  });

  socket.on('decline_draw', ({ gameId }) => {
    if (!socket.username) return;
    const game = games.get(gameId);
    if (!game) return;
    const offerer = game.drawOffer;
    game.drawOffer = null;
    if (offerer) {
      const offSock = io.sockets.sockets.get(users.get(offerer)?.socketId);
      if (offSock) offSock.emit('toast_msg', `${socket.username} durrangni rad etdi`);
    }
  });

  socket.on('game_result', ({ gameId, reason, winner }) => {
    const game = games.get(gameId);
    if (!game || game.status !== 'playing') return;
    game.status = 'ended';
    io.to(gameId).emit('game_over', { reason, winner });
    if (winner && reason !== 'draw') {
      const loser = winner === game.white ? game.black : game.white;
      const wu = users.get(winner); const lu = users.get(loser);
      if (wu) wu.rating += 10;
      if (lu) lu.rating = Math.max(100, lu.rating - 10);
      broadcastUserList();
    }
    setTimeout(() => games.delete(gameId), 60000);
  });

  socket.on('disconnect', () => {
    const user = getUserBySocket(socket.id);
    if (user) {
      user.online = false;
      seeks.delete(user.username);
      broadcastSeekList();
      if (socket.gameId) {
        const game = games.get(socket.gameId);
        if (game && game.status === 'playing') {
          const opp = game.white === user.username ? game.black : game.white;
          io.to(socket.gameId).emit('game_over', { reason: 'disconnect', winner: opp });
          game.status = 'ended';
        }
      }
      broadcastUserList();
    }
  });

  socket.on('ping_server', () => socket.emit('pong_server'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server: http://localhost:${PORT}`));
