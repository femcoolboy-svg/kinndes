const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bcrypt = require('bcrypt');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// ------------------ ХРАНИЛИЩЕ ДАННЫХ (в памяти) ------------------
const users = [];        // { id, username, passwordHash, tag, created_at, avatar, banner, bio, status, plus, banned }
const friends = [];      // { id, user_id, friend_id, status } status: 'pending', 'accepted'
const groups = [];       // { id, name, owner_id, created_at, members: [] }
const groupInvites = []; // { id, group_id, from_user_id, to_user_id, status }
const messages = [];     // { id, from_user_id, to_user_id, message, timestamp }
const groupMessages = [];// { id, group_id, from_user_id, fromName, message, timestamp }

let nextUserId = 1;
let nextFriendId = 1;
let nextGroupId = 1;
let nextInviteId = 1;
let nextMsgId = 1;
let nextGroupMsgId = 1;

// Хешируем пароль для админа prisanok / qazzaq32qaz
(async () => {
  const adminPassHash = await bcrypt.hash('qazzaq32qaz', 10);
  users.push({
    id: nextUserId++,
    username: 'prisanok',
    passwordHash: adminPassHash,
    tag: Math.floor(Math.random() * 10000).toString().padStart(4, '0'),
    created_at: new Date().toISOString(),
    avatar: null,
    banner: null,
    bio: 'Создатель Kinders',
    status: 'online',
    plus: true,
    banned: false
  });
})();

// Вспомогательная функция для генерации тега
function generateTag() {
  return Math.floor(Math.random() * 10000).toString().padStart(4, '0');
}

// ------------------ МИДЛВЭР ДЛЯ АВТОРИЗАЦИИ (сессии) ------------------
// В реальном проекте используй JWT, но для простоты сделаем через cookie
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username && !u.banned);
  if (!user) return res.json({ success: false, error: 'Неверное имя или пароль' });
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.json({ success: false, error: 'Неверное имя или пароль' });
  req.session = { userId: user.id };
  res.json({ success: true, user: { id: user.id, username: user.username, tag: user.tag, created_at: user.created_at, avatar: user.avatar, banner: user.banner, bio: user.bio, plus: user.plus, plus_color: user.plus_color, plus_badge: user.plus_badge, plus_animated_avatar: user.plus_animated_avatar, plus_banner_video: user.plus_banner_video } });
});

app.post('/register', async (req, res) => {
  const { username, password, email, captcha, ip } = req.body;
  if (users.find(u => u.username === username)) return res.json({ success: false, error: 'Никнейм занят' });
  if (password.length < 4) return res.json({ success: false, error: 'Пароль минимум 4 символа' });
  const hash = await bcrypt.hash(password, 10);
  const newUser = {
    id: nextUserId++,
    username,
    passwordHash: hash,
    tag: generateTag(),
    created_at: new Date().toISOString(),
    avatar: null,
    banner: null,
    bio: '',
    status: 'online',
    plus: false,
    banned: false
  };
  users.push(newUser);
  req.session = { userId: newUser.id };
  res.json({ success: true, user: { id: newUser.id, username: newUser.username, tag: newUser.tag, created_at: newUser.created_at, avatar: newUser.avatar, banner: newUser.banner, bio: newUser.bio, plus: newUser.plus } });
});

app.get('/session', (req, res) => {
  if (!req.session || !req.session.userId) return res.json({ success: false });
  const user = users.find(u => u.id === req.session.userId);
  if (!user || user.banned) return res.json({ success: false });
  res.json({ success: true, user: { id: user.id, username: user.username, tag: user.tag, created_at: user.created_at, avatar: user.avatar, banner: user.banner, bio: user.bio, plus: user.plus, plus_color: user.plus_color, plus_badge: user.plus_badge, plus_animated_avatar: user.plus_animated_avatar, plus_banner_video: user.plus_banner_video } });
});

app.post('/logout', (req, res) => {
  req.session = null;
  res.json({ success: true });
});

// ------------------ ДРУЗЬЯ ------------------
app.post('/friends', (req, res) => {
  const { userId } = req.body;
  const userFriends = friends.filter(f => (f.user_id === userId || f.friend_id === userId) && f.status === 'accepted');
  const friendList = userFriends.map(f => {
    const friendId = f.user_id === userId ? f.friend_id : f.user_id;
    const friend = users.find(u => u.id === friendId);
    return { id: friend.id, username: friend.username, tag: friend.tag, avatar: friend.avatar, status: friend.status };
  });
  res.json({ friends: friendList });
});

app.post('/requests', (req, res) => {
  const { userId } = req.body;
  const pending = friends.filter(f => f.friend_id === userId && f.status === 'pending');
  const requestList = pending.map(f => {
    const requester = users.find(u => u.id === f.user_id);
    return { id: f.id, user_id: requester.id, username: requester.username, tag: requester.tag };
  });
  res.json({ requests: requestList });
});

app.post('/friend/add', async (req, res) => {
  const { from, to } = req.body;
  if (from === to) return res.json({ success: false, error: 'Нельзя добавить себя' });
  const existing = friends.find(f => (f.user_id === from && f.friend_id === to) || (f.user_id === to && f.friend_id === from));
  if (existing) return res.json({ success: false, error: 'Запрос уже отправлен или вы уже друзья' });
  friends.push({ id: nextFriendId++, user_id: from, friend_id: to, status: 'pending' });
  res.json({ success: true });
});

app.post('/friend/accept', (req, res) => {
  const { id, from, to } = req.body;
  const friendRecord = friends.find(f => f.id === id);
  if (friendRecord) friendRecord.status = 'accepted';
  res.json({ success: true });
});

app.post('/friend/decline', (req, res) => {
  const { id } = req.body;
  const idx = friends.findIndex(f => f.id === id);
  if (idx !== -1) friends.splice(idx, 1);
  res.json({ success: true });
});

// ------------------ ПОИСК ------------------
app.post('/search', (req, res) => {
  const { q } = req.body;
  if (q === 'prisanok') {
    // специально для админа можно вернуть ссылку на Discord, но необязательно
    return res.json({ isDiscord: true, id: 'prisanok' });
  }
  const found = users.filter(u => u.username.toLowerCase().includes(q.toLowerCase()) && !u.banned);
  const result = found.map(u => ({ id: u.id, username: u.username, tag: u.tag }));
  res.json({ users: result });
});

// ------------------ ЛИЧНЫЕ СООБЩЕНИЯ ------------------
app.post('/send-message', (req, res) => {
  const { from_user_id, to_user_id, message } = req.body;
  const newMsg = {
    id: nextMsgId++,
    from_user_id,
    to_user_id,
    message,
    timestamp: new Date().toISOString()
  };
  messages.push(newMsg);
  res.json({ success: true });
});

app.post('/messages', (req, res) => {
  const { u1, u2 } = req.body;
  const chat = messages.filter(m => (m.from_user_id === u1 && m.to_user_id === u2) || (m.from_user_id === u2 && m.to_user_id === u1));
  chat.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
  res.json({ messages: chat });
});

// ------------------ ГРУППЫ ------------------
app.post('/group/create', (req, res) => {
  const { name, owner, members } = req.body;
  if (!members || members.length < 2) return res.json({ success: false, error: 'Нужно минимум 2 участника' });
  const newGroup = {
    id: nextGroupId++,
    name,
    owner_id: owner,
    created_at: new Date().toISOString(),
    members: [...new Set([owner, ...members])]
  };
  groups.push(newGroup);
  // Отправляем приглашения всем добавленным (кроме владельца)
  for (let m of members) {
    if (m !== owner) {
      groupInvites.push({ id: nextInviteId++, group_id: newGroup.id, from_user_id: owner, to_user_id: m, status: 'pending' });
    }
  }
  res.json({ success: true });
});

app.post('/groups', (req, res) => {
  const { userId } = req.body;
  const userGroups = groups.filter(g => g.members.includes(userId));
  res.json({ groups: userGroups.map(g => ({ id: g.id, name: g.name })) });
});

app.post('/group/messages', (req, res) => {
  const { groupId } = req.body;
  const msgs = groupMessages.filter(m => m.group_id === groupId).sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
  res.json({ messages: msgs });
});

app.post('/group/send-message', (req, res) => {
  const { group_id, from_user_id, message } = req.body;
  const group = groups.find(g => g.id === group_id);
  if (!group || !group.members.includes(from_user_id)) return res.json({ success: false });
  const fromUser = users.find(u => u.id === from_user_id);
  const newMsg = {
    id: nextGroupMsgId++,
    group_id,
    from_user_id,
    fromName: fromUser.username,
    message,
    timestamp: new Date().toISOString()
  };
  groupMessages.push(newMsg);
  // Рассылаем через сокеты всем участникам группы
  io.emit('group-message', { group: group_id, from: from_user_id, fromName: fromUser.username, msg: message, time: newMsg.timestamp });
  res.json({ success: true });
});

// ------------------ АДМИНКА (бан) ------------------
app.get('/all-users', (req, res) => {
  const all = users.filter(u => !u.banned).map(u => ({ id: u.id, username: u.username, tag: u.tag, banned: u.banned }));
  res.json({ users: all });
});

app.post('/ban', (req, res) => {
  const { userId, reason } = req.body;
  const user = users.find(u => u.id === userId);
  if (user) user.banned = true;
  res.json({ success: true });
});

app.post('/unban', (req, res) => {
  const { userId } = req.body;
  const user = users.find(u => u.id === userId);
  if (user) user.banned = false;
  res.json({ success: true });
});

// ------------------ WEB SOCKETS ------------------
io.use((socket, next) => {
  // Можно добавить авторизацию по сессии, но для простоты пропускаем
  next();
});

io.on('connection', (socket) => {
  let userId = null;
  socket.on('register', (id) => {
    userId = id;
    socket.join(`user_${id}`);
  });

  socket.on('private-message', (data) => {
    const { from, to, msg, fromName } = data;
    // Сохраняем в БД (уже есть в /send-message, но дублируем для надёжности)
    const newMsg = {
      id: nextMsgId++,
      from_user_id: from,
      to_user_id: to,
      message: msg,
      timestamp: new Date().toISOString()
    };
    messages.push(newMsg);
    io.to(`user_${to}`).emit('private-message', { from, msg, time: newMsg.timestamp, fromName });
  });

  socket.on('group-message', (data) => {
    const { group, from, fromName, msg } = data;
    const groupObj = groups.find(g => g.id === group);
    if (groupObj) {
      const newMsg = {
        id: nextGroupMsgId++,
        group_id: group,
        from_user_id: from,
        fromName,
        message: msg,
        timestamp: new Date().toISOString()
      };
      groupMessages.push(newMsg);
      // Отправляем всем участникам группы
      groupObj.members.forEach(memberId => {
        io.to(`user_${memberId}`).emit('group-message', { group, from, fromName, msg, time: newMsg.timestamp });
      });
    }
  });
});

// ------------------ ЗАПУСК ------------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`✅ Kinders сервер запущен на порту ${PORT}`);
});
