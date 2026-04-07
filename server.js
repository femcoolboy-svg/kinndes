const express = require('express');
const session = require('express-session');
const http = require('http');
const socketIo = require('socket.io');
const bcrypt = require('bcrypt');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('.'));
app.use(session({
    secret: 'kinders_secret_2024',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// ---------- НАСТРОЙКИ ЮMONEY ----------
const YOOMONEY_WALLET = '4100118589497198';
const YOOMONEY_SECRET = 'your_secret_key_here'; // Замените на секретное слово из настроек ЮMoney
const BASE_URL = process.env.BASE_URL || 'https://your-domain.com'; // Укажите ваш домен

// ---------- ЗАГРУЗКА ФАЙЛОВ ----------
const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ---------- ДАННЫЕ В ПАМЯТИ ----------
let users = [];
let friends = [];
let groups = [];
let privateMessages = [];
let groupMessages = [];
let userSettings = [];
let subscriptions = [];      // { userId, expiresAt, plan, paymentId? }
let bannedIps = [];
let pendingPayments = [];    // временное хранение перед подтверждением

let nextUserId = 1, nextFriendId = 1, nextGroupId = 1, nextMsgId = 1, nextGroupMsgId = 1;

// ---------- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ----------
function isPremium(userId) {
    const sub = subscriptions.find(s => s.userId === userId);
    if (!sub) return false;
    if (new Date(sub.expiresAt) > new Date()) return true;
    subscriptions = subscriptions.filter(s => s.userId !== userId);
    return false;
}

function getMaxFriends(userId) { return isPremium(userId) ? 10000 : 25; }
function getMaxGroupMembers(userId) { return isPremium(userId) ? 200 : 9; }

function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }

function isUsernameForbidden(username) {
    const lower = username.toLowerCase();
    const forbidden = ['admin', 'owner', 'moderator', 'kinders', 'root', 'administrator', 'support'];
    return forbidden.includes(lower);
}

function getClientIp(req) {
    let ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    if (!ip || ip === '::1') ip = '127.0.0.1';
    return ip;
}

// ---------- АДМИН (создаётся при первом запуске) ----------
(async () => {
    if (!users.find(u => u.username === 'prisanok')) {
        const hash = await bcrypt.hash('qazzaq32qaz', 10);
        users.push({
            id: nextUserId++,
            username: 'prisanok',
            passwordHash: hash,
            tag: '0001',
            created_at: new Date().toISOString(),
            avatar: null,
            bio: 'Создатель',
            banned: false,
            registration_ip: '62.140.249.69'
        });
    }
})();

function generateTag() { return Math.floor(Math.random()*10000).toString().padStart(4,'0'); }

// ---------- РЕГИСТРАЦИЯ С БАНОМ IP ----------
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    const clientIp = getClientIp(req);
    if (bannedIps.includes(clientIp)) {
        return res.json({ success: false, error: 'Ваш IP заблокирован.' });
    }
    if (!username || !password) return res.json({ success: false, error: 'Заполните поля' });
    if (isUsernameForbidden(username)) {
        if (!bannedIps.includes(clientIp)) bannedIps.push(clientIp);
        return res.json({ success: false, error: 'Этот никнейм запрещён. IP заблокирован.' });
    }
    if (users.find(u => u.username === username)) return res.json({ success: false, error: 'Ник занят' });
    if (password.length < 4) return res.json({ success: false, error: 'Пароль минимум 4 символа' });
    const hash = await bcrypt.hash(password, 10);
    const newUser = {
        id: nextUserId++,
        username,
        passwordHash: hash,
        tag: generateTag(),
        created_at: new Date().toISOString(),
        avatar: null,
        bio: '',
        banned: false,
        registration_ip: clientIp
    };
    users.push(newUser);
    req.session.userId = newUser.id;
    res.json({ success: true, user: { id: newUser.id, username: newUser.username, tag: newUser.tag } });
});

// ---------- ВХОД ----------
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username && !u.banned);
    if (!user) return res.json({ success: false, error: 'Неверные данные' });
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.json({ success: false, error: 'Неверные данные' });
    req.session.userId = user.id;
    res.json({ success: true, user: { id: user.id, username: user.username, tag: user.tag } });
});

// ---------- СЕССИЯ ----------
app.get('/session', (req, res) => {
    if (!req.session.userId) return res.json({ success: false });
    const user = users.find(u => u.id === req.session.userId && !u.banned);
    if (!user) return res.json({ success: false });
    const settings = userSettings.find(s => s.userId === user.id) || {};
    res.json({
        success: true,
        user: {
            id: user.id,
            username: user.username,
            tag: user.tag,
            created_at: user.created_at,
            avatar: user.avatar
        },
        isPremium: isPremium(user.id),
        settings: {
            nickColor: settings.nickColor,
            animatedAvatar: settings.animatedAvatar,
            videoBanner: settings.videoBanner,
            plusBadge: settings.plusBadge || '⭐'
        }
    });
});

app.post('/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

// ---------- ДРУЗЬЯ (с фильтром несуществующих) ----------
app.post('/friends', (req, res) => {
    if (!req.session.userId) return res.json({ friends: [] });
    const userId = req.session.userId;
    let userFriends = friends.filter(f => (f.user_id === userId || f.friend_id === userId) && f.status === 'accepted');
    const friendList = userFriends.map(f => {
        const friendId = f.user_id === userId ? f.friend_id : f.user_id;
        const friend = users.find(u => u.id === friendId && !u.banned);
        if (!friend) return null;
        const s = userSettings.find(ss => ss.userId === friendId) || {};
        return {
            id: friend.id,
            username: friend.username,
            tag: friend.tag,
            nickColor: s.nickColor,
            plusBadge: isPremium(friend.id) ? (s.plusBadge || '⭐') : null
        };
    }).filter(f => f !== null);
    res.json({ friends: friendList, maxFriends: getMaxFriends(userId), currentCount: friendList.length });
});

app.post('/requests', (req, res) => {
    if (!req.session.userId) return res.json({ requests: [] });
    const pending = friends.filter(f => f.friend_id === req.session.userId && f.status === 'pending');
    const requestList = pending.map(f => {
        const requester = users.find(u => u.id === f.user_id && !u.banned);
        if (!requester) return null;
        return { id: f.id, user_id: requester.id, username: requester.username, tag: requester.tag };
    }).filter(r => r !== null);
    res.json({ requests: requestList });
});

app.post('/friend/add', (req, res) => {
    if (!req.session.userId) return res.json({ success: false, error: 'Не авторизован' });
    const { to } = req.body;
    const from = req.session.userId;
    if (from === to) return res.json({ success: false, error: 'Нельзя добавить себя' });
    const targetUser = users.find(u => u.id === to && !u.banned);
    if (!targetUser) return res.json({ success: false, error: 'Пользователь не найден' });
    const currentCount = friends.filter(f => (f.user_id === from || f.friend_id === from) && f.status === 'accepted').length;
    if (currentCount >= getMaxFriends(from)) return res.json({ success: false, error: `Лимит друзей: ${getMaxFriends(from)}. Купите Kinders+` });
    if (friends.find(f => (f.user_id === from && f.friend_id === to) || (f.user_id === to && f.friend_id === from))) {
        return res.json({ success: false, error: 'Запрос уже отправлен' });
    }
    friends.push({ id: nextFriendId++, user_id: from, friend_id: to, status: 'pending' });
    res.json({ success: true });
});

app.post('/friend/accept', (req, res) => { const fr = friends.find(f => f.id === req.body.id); if(fr) fr.status = 'accepted'; res.json({ success: true }); });
app.post('/friend/decline', (req, res) => { friends = friends.filter(f => f.id !== req.body.id); res.json({ success: true }); });

// ---------- ПОИСК ----------
app.post('/search', (req, res) => {
    const { q } = req.body;
    if (!q) return res.json({ users: [] });
    const found = users.filter(u => u.username.toLowerCase().includes(q.toLowerCase()) && !u.banned && u.username !== 'prisanok');
    res.json({ users: found.map(u => ({ id: u.id, username: u.username, tag: u.tag })) });
});

// ---------- СООБЩЕНИЯ ----------
app.post('/send-message', (req, res) => {
    if (!req.session.userId) return res.json({ success: false });
    privateMessages.push({ id: nextMsgId++, from_user_id: req.session.userId, to_user_id: req.body.to_user_id, message: req.body.message, timestamp: new Date().toISOString() });
    res.json({ success: true });
});

app.post('/messages', (req, res) => {
    if (!req.session.userId) return res.json({ messages: [] });
    const { u2 } = req.body;
    const u1 = req.session.userId;
    let chat = privateMessages.filter(m => (m.from_user_id === u1 && m.to_user_id === u2) || (m.from_user_id === u2 && m.to_user_id === u1));
    chat.sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
    res.json({ messages: chat });
});

// ---------- ГРУППЫ ----------
app.post('/group/create', (req, res) => {
    if (!req.session.userId) return res.json({ success: false });
    const { name, memberIds } = req.body;
    const owner = req.session.userId;
    let members = [...new Set([owner, ...(memberIds || [])])];
    const maxMem = getMaxGroupMembers(owner);
    if (members.length > maxMem) return res.json({ success: false, error: `Максимум ${maxMem} участников. Купите Kinders+` });
    if (members.length < 2) return res.json({ success: false, error: 'Выберите хотя бы одного друга' });
    groups.push({ id: nextGroupId++, name, owner_id: owner, created_at: new Date().toISOString(), members });
    res.json({ success: true, groupId: nextGroupId-1 });
});

app.post('/groups', (req, res) => {
    if (!req.session.userId) return res.json({ groups: [] });
    const userGroups = groups.filter(g => g.members.includes(req.session.userId));
    res.json({ groups: userGroups.map(g => ({ id: g.id, name: g.name, membersCount: g.members.length, owner_id: g.owner_id })) });
});

app.post('/group/members', (req, res) => {
    if (!req.session.userId) return res.json({ members: [] });
    const { groupId } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (!group || !group.members.includes(req.session.userId)) return res.json({ members: [] });
    const memberList = group.members.map(mid => {
        const u = users.find(u => u.id === mid && !u.banned);
        if (!u) return null;
        return { id: u.id, username: u.username, tag: u.tag };
    }).filter(m => m !== null);
    res.json({ members: memberList, ownerId: group.owner_id });
});

app.post('/group/kick', (req, res) => {
    if (!req.session.userId) return res.json({ success: false });
    const { groupId, targetUserId } = req.body;
    const group = groups.find(g => g.id === groupId);
    if (!group || group.owner_id !== req.session.userId) return res.json({ success: false });
    if (targetUserId === group.owner_id) return res.json({ success: false, error: 'Нельзя кикнуть создателя' });
    group.members = group.members.filter(m => m !== targetUserId);
    res.json({ success: true });
});

app.post('/group/send-message', (req, res) => {
    if (!req.session.userId) return res.json({ success: false });
    const { group_id, message } = req.body;
    const group = groups.find(g => g.id === group_id);
    if (!group || !group.members.includes(req.session.userId)) return res.json({ success: false });
    const fromUser = users.find(u => u.id === req.session.userId);
    const newMsg = { id: nextGroupMsgId++, group_id, from_user_id: req.session.userId, fromName: fromUser.username, message, timestamp: new Date().toISOString() };
    groupMessages.push(newMsg);
    group.members.forEach(mid => {
        io.to(`user_${mid}`).emit('group-message', { group: group_id, from: req.session.userId, fromName: fromUser.username, msg: message, time: newMsg.timestamp });
    });
    res.json({ success: true });
});

app.post('/group/messages', (req, res) => {
    const msgs = groupMessages.filter(m => m.group_id === req.body.groupId).sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
    res.json({ messages: msgs });
});

// ---------- ЗАГРУЗКА ФАЙЛОВ ----------
app.post('/upload-avatar', upload.single('avatar'), (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Не авторизован' });
    const user = users.find(u => u.id === req.session.userId);
    if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
    user.avatar = `/uploads/${req.file.filename}`;
    res.json({ success: true, avatarUrl: user.avatar });
});

app.post('/upload-gif-avatar', upload.single('gif'), (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Не авторизован' });
    if (!isPremium(req.session.userId)) return res.status(403).json({ error: 'Только для Kinders+' });
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
    let settings = userSettings.find(s => s.userId === req.session.userId);
    if (!settings) { settings = { userId: req.session.userId }; userSettings.push(settings); }
    settings.animatedAvatar = `/uploads/${req.file.filename}`;
    res.json({ success: true });
});

app.post('/upload-video-banner', upload.single('video'), (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Не авторизован' });
    if (!isPremium(req.session.userId)) return res.status(403).json({ error: 'Только для Kinders+' });
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
    let settings = userSettings.find(s => s.userId === req.session.userId);
    if (!settings) { settings = { userId: req.session.userId }; userSettings.push(settings); }
    settings.videoBanner = `/uploads/${req.file.filename}`;
    res.json({ success: true });
});

// ---------- НАСТРОЙКИ ПРЕМИУМ ----------
app.post('/save-premium-settings', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Не авторизован' });
    if (!isPremium(req.session.userId)) return res.status(403).json({ error: 'Доступно только для Kinders+' });
    const { nickColor, plusBadge } = req.body;
    let settings = userSettings.find(s => s.userId === req.session.userId);
    if (!settings) { settings = { userId: req.session.userId }; userSettings.push(settings); }
    if (nickColor !== undefined) settings.nickColor = nickColor;
    if (plusBadge !== undefined) settings.plusBadge = plusBadge;
    res.json({ success: true });
});

app.post('/change-username', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Не авторизован' });
    const { newUsername } = req.body;
    if (!newUsername || newUsername.length < 3) return res.json({ success: false, error: 'Ник от 3 символов' });
    if (isUsernameForbidden(newUsername)) return res.json({ success: false, error: 'Этот ник запрещён' });
    const user = users.find(u => u.id === req.session.userId);
    if (!user) return res.json({ success: false, error: 'Пользователь не найден' });
    if (users.find(u => u.username === newUsername && u.id !== user.id)) return res.json({ success: false, error: 'Ник занят' });
    user.username = newUsername;
    res.json({ success: true });
});

// ---------- ПЛАТЕЖИ ЮMONEY (реальная интеграция) ----------
const PLAN_PRICES = {
    week: 49,
    month: 149,
    year: 1290,
    forever: 4990
};
const PLAN_DAYS = {
    week: 7,
    month: 30,
    year: 365,
    forever: 36500
};

// Создание платежа (возвращает форму для отправки на ЮMoney)
app.post('/create-payment', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Не авторизован' });
    const { plan } = req.body;
    if (!PLAN_PRICES[plan]) return res.status(400).json({ error: 'Неверный тариф' });
    const amount = PLAN_PRICES[plan];
    const userId = req.session.userId;
    const user = users.find(u => u.id === userId);
    if (!user) return res.status(401).json({ error: 'Пользователь не найден' });

    // Генерируем уникальный номер платежа (можно сохранить в pendingPayments)
    const paymentId = Date.now() + '-' + userId + '-' + Math.random().toString(36).substr(2, 8);
    pendingPayments.push({ paymentId, userId, plan, amount, createdAt: new Date() });

    // Формируем параметры для формы ЮMoney (быстрый платёж)
    const formHtml = `
        <form id="yoomoneyForm" action="https://yoomoney.ru/quickpay/confirm.xml" method="POST" target="_blank">
            <input type="hidden" name="receiver" value="${YOOMONEY_WALLET}">
            <input type="hidden" name="formcomment" value="Kinders+ Premium">
            <input type="hidden" name="short-dest" value="Подписка Kinders+ для ${user.username}">
            <input type="hidden" name="label" value="${paymentId}">
            <input type="hidden" name="quickpay-form" value="small">
            <input type="hidden" name="targets" value="Kinders+ Premium (${plan})">
            <input type="hidden" name="sum" value="${amount}" data-type="number">
            <input type="hidden" name="comment" value="${user.username} #${user.tag}">
            <input type="hidden" name="need-fio" value="false">
            <input type="hidden" name="need-email" value="false">
            <input type="hidden" name="need-phone" value="false">
            <input type="hidden" name="need-address" value="false">
            <input type="hidden" name="paymentType" value="PC">
        </form>
        <script>document.getElementById('yoomoneyForm').submit();</script>
    `;
    res.send(formHtml);
});

// Webhook для приёма уведомлений от ЮMoney (указывается в настройках магазина)
app.post('/yoomoney-webhook', (req, res) => {
    // Проверка подписи (если задан секрет)
    const notification_type = req.body.notification_type;
    const operation_id = req.body.operation_id;
    const amount = req.body.amount;
    const currency = req.body.currency;
    const datetime = req.body.datetime;
    const sender = req.body.sender;
    const codepro = req.body.codepro;
    const label = req.body.label;   // наш paymentId
    const sha1_hash = req.body.sha1_hash;

    // В реальности нужно проверить sha1_hash (если есть секрет)
    // Здесь упрощённо: ищем paymentId в pendingPayments
    const payment = pendingPayments.find(p => p.paymentId === label);
    if (!payment) return res.sendStatus(200);

    // Активируем подписку
    const days = PLAN_DAYS[payment.plan];
    const expiresAt = addDays(new Date(), days);
    subscriptions = subscriptions.filter(s => s.userId !== payment.userId);
    subscriptions.push({ userId: payment.userId, expiresAt, plan: payment.plan });
    // Удаляем из pending
    pendingPayments = pendingPayments.filter(p => p.paymentId !== label);
    console.log(`Подписка активирована для user ${payment.userId}, план ${payment.plan}`);
    res.sendStatus(200);
});

// Ручная проверка (если webhook не пришёл, пользователь может подтвердить сам)
app.post('/check-payment', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Не авторизован' });
    const { paymentId } = req.body;
    const payment = pendingPayments.find(p => p.paymentId === paymentId);
    if (!payment || payment.userId !== req.session.userId) return res.json({ success: false, error: 'Платёж не найден' });
    // В идеале здесь сделать запрос к API ЮMoney для проверки статуса, но для демо:
    res.json({ success: false, error: 'Ожидайте подтверждения от администратора или используйте автоматический webhook.' });
});

// Для отладки: получить статус подписки
app.get('/premium-status', (req, res) => {
    if (!req.session.userId) return res.json({ success: false });
    res.json({ isPremium: isPremium(req.session.userId) });
});

// ---------- АДМИНКА ----------
app.get('/all-users', (req, res) => {
    if (!req.session.userId) return res.json({ users: [] });
    const cur = users.find(u => u.id === req.session.userId);
    if (cur?.username !== 'prisanok') return res.json({ users: [] });
    res.json({ users: users.filter(u => !u.banned && u.username !== 'prisanok').map(u => ({ id: u.id, username: u.username, tag: u.tag })) });
});

app.post('/ban', (req, res) => {
    if (!req.session.userId) return res.json({ success: false });
    const cur = users.find(u => u.id === req.session.userId);
    if (cur?.username !== 'prisanok') return res.json({ success: false });
    const user = users.find(u => u.id === req.body.userId);
    if (user && user.username !== 'prisanok') user.banned = true;
    res.json({ success: true });
});

app.get('/banned-ips', (req, res) => {
    if (!req.session.userId) return res.json({ ips: [] });
    const cur = users.find(u => u.id === req.session.userId);
    if (cur?.username !== 'prisanok') return res.json({ ips: [] });
    res.json({ ips: bannedIps });
});

app.post('/unban-ip', (req, res) => {
    if (!req.session.userId) return res.json({ success: false });
    const cur = users.find(u => u.id === req.session.userId);
    if (cur?.username !== 'prisanok') return res.json({ success: false });
    const { ip } = req.body;
    bannedIps = bannedIps.filter(i => i !== ip);
    res.json({ success: true });
});

// ---------- WEBSOCKET + ЗВОНКИ (исправлено) ----------
io.on('connection', (socket) => {
    socket.on('register', (id) => { socket.join(`user_${id}`); socket.userId = id; });

    socket.on('private-message', (data) => {
        privateMessages.push({ id: nextMsgId++, from_user_id: data.from, to_user_id: data.to, message: data.msg, timestamp: new Date().toISOString() });
        io.to(`user_${data.to}`).emit('private-message', { from: data.from, msg: data.msg, time: new Date().toISOString(), fromName: data.fromName });
    });

    socket.on('group-message', (data) => {
        // Сохраняем сообщение в БД
        const newMsg = { id: nextGroupMsgId++, group_id: data.group, from_user_id: data.from, fromName: data.fromName, message: data.msg, timestamp: new Date().toISOString() };
        groupMessages.push(newMsg);
        // Рассылаем участникам группы
        const group = groups.find(g => g.id === data.group);
        if (group) {
            group.members.forEach(mid => {
                io.to(`user_${mid}`).emit('group-message', { group: data.group, from: data.from, fromName: data.fromName, msg: data.msg, time: newMsg.timestamp });
            });
        }
    });

    socket.on('call-user', (data) => { io.to(`user_${data.to}`).emit('call-made', { from: socket.userId, offer: data.offer, fromName: data.fromName }); });
    socket.on('call-answer', (data) => { io.to(`user_${data.to}`).emit('call-answered', { from: socket.userId, answer: data.answer }); });
    socket.on('ice-candidate', (data) => { io.to(`user_${data.to}`).emit('ice-candidate', { from: socket.userId, candidate: data.candidate }); });
    socket.on('end-call', (data) => { io.to(`user_${data.to}`).emit('call-ended', { from: socket.userId }); });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Kinders server running on port ${PORT}`));
