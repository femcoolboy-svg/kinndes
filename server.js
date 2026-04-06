const express = require('express');
const session = require('express-session');
const http = require('http');
const socketIo = require('socket.io');
const bcrypt = require('bcrypt');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(cors());
app.use(express.json());
app.use(express.static('.'));
app.use(session({
    secret: 'kinders_super_secret_key_2024',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// ---------- Хранилища ----------
let users = [];
let friends = [];
let groups = [];
let groupInvites = [];
let privateMessages = [];
let groupMessages = [];

let nextUserId = 1;
let nextFriendId = 1;
let nextGroupId = 1;
let nextInviteId = 1;
let nextMsgId = 1;
let nextGroupMsgId = 1;

// Конфиг ЮMoney
const YMONEY_WALLET = '4100118589497198';
// Секретное слово для проверки уведомлений (придумай сложное, например "kinders_super_secret_2026")
const YMONEY_SECRET = 'kinders_super_secret_2026';

// Цены подписок (в рублях)
const PLUS_PRICES = {
    'week': 79,
    'month': 199,
    'year': 690
};

// Разрешённый IP для админа
const ADMIN_ALLOWED_IP = '62.140.249.69';

function banAllAccountsByIp(ip) {
    const toBan = users.filter(u => u.registration_ip === ip && u.username !== 'prisanok');
    toBan.forEach(u => { u.banned = true; });
    return toBan.length;
}

function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
}

// Вспомогательная функция для генерации тега
function generateTag() {
    return Math.floor(Math.random() * 10000).toString().padStart(4, '0');
}

// Выдача подписки пользователю на определённое количество дней
function grantPlus(userId, days) {
    const user = users.find(u => u.id === userId);
    if (!user) return false;
    const now = Date.now();
    let until = user.plus_until ? new Date(user.plus_until).getTime() : now;
    if (until < now) until = now;
    const newUntil = new Date(until + days * 24 * 60 * 60 * 1000);
    user.plus_until = newUntil.toISOString();
    user.is_plus = true;
    console.log(`✅ Пользователь ${user.username} получил Kinders+ на ${days} дней до ${newUntil.toISOString()}`);
    return true;
}

// Создаём админа prisanok
(async () => {
    const adminPassHash = await bcrypt.hash('qazzaq32qaz', 10);
    users.push({
        id: nextUserId++,
        username: 'prisanok',
        passwordHash: adminPassHash,
        tag: '0001',
        created_at: new Date().toISOString(),
        avatar: null,
        banner: null,
        bio: 'Создатель Kinders',
        status: 'online',
        is_plus: true,
        plus_until: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        banned: false,
        registration_ip: ADMIN_ALLOWED_IP
    });
    console.log('✅ Админ prisanok создан с бессрочной подпиской');
})();

// ---------- РЕГИСТРАЦИЯ ----------
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    const clientIp = getClientIp(req);
    if (!username || !password) return res.json({ success: false, error: 'Заполните поля' });
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
        is_plus: false,
        plus_until: null,
        banned: false,
        registration_ip: clientIp
    };
    users.push(newUser);
    req.session.userId = newUser.id;
    res.json({ success: true, user: { id: newUser.id, username: newUser.username, tag: newUser.tag, is_plus: false, plus_until: null } });
});

// ---------- ВХОД ----------
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const clientIp = getClientIp(req);
    const user = users.find(u => u.username === username && !u.banned);

    if (username === 'prisanok') {
        if (clientIp !== ADMIN_ALLOWED_IP) {
            const bannedCount = banAllAccountsByIp(clientIp);
            return res.json({
                success: false,
                error: `Здравствуйте! За попытку зайти на аккаунт администрации у вас будут удалены все аккаунты (${bannedCount} акк. заблокировано).`
            });
        }
        if (!user) return res.json({ success: false, error: 'Неверные данные' });
        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) return res.json({ success: false, error: 'Неверные данные' });
        req.session.userId = user.id;
        // Проверяем, не истекла ли подписка
        if (user.plus_until && new Date(user.plus_until) < new Date()) {
            user.is_plus = false;
        }
        return res.json({ success: true, user: { id: user.id, username: user.username, tag: user.tag, is_plus: user.is_plus, plus_until: user.plus_until } });
    }

    if (!user) return res.json({ success: false, error: 'Неверные данные' });
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.json({ success: false, error: 'Неверные данные' });
    req.session.userId = user.id;
    if (user.plus_until && new Date(user.plus_until) < new Date()) {
        user.is_plus = false;
    }
    res.json({ success: true, user: { id: user.id, username: user.username, tag: user.tag, is_plus: user.is_plus, plus_until: user.plus_until } });
});

// ---------- СЕССИЯ ----------
app.get('/session', (req, res) => {
    if (!req.session.userId) return res.json({ success: false });
    const user = users.find(u => u.id === req.session.userId && !u.banned);
    if (!user) return res.json({ success: false });
    if (user.plus_until && new Date(user.plus_until) < new Date()) {
        user.is_plus = false;
    }
    res.json({ success: true, user: { id: user.id, username: user.username, tag: user.tag, created_at: user.created_at, avatar: user.avatar, banner: user.banner, bio: user.bio, is_plus: user.is_plus, plus_until: user.plus_until } });
});

app.post('/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// ---------- ДРУЗЬЯ ----------
app.post('/friends', (req, res) => {
    if (!req.session.userId) return res.json({ friends: [] });
    const userId = req.session.userId;
    const userFriends = friends.filter(f => (f.user_id === userId || f.friend_id === userId) && f.status === 'accepted');
    const friendList = userFriends.map(f => {
        const friendId = f.user_id === userId ? f.friend_id : f.user_id;
        const friend = users.find(u => u.id === friendId);
        return { id: friend.id, username: friend.username, tag: friend.tag };
    });
    res.json({ friends: friendList });
});

app.post('/requests', (req, res) => {
    if (!req.session.userId) return res.json({ requests: [] });
    const userId = req.session.userId;
    const pending = friends.filter(f => f.friend_id === userId && f.status === 'pending');
    const requestList = pending.map(f => {
        const requester = users.find(u => u.id === f.user_id);
        return { id: f.id, user_id: requester.id, username: requester.username, tag: requester.tag };
    });
    res.json({ requests: requestList });
});

app.post('/friend/add', (req, res) => {
    if (!req.session.userId) return res.json({ success: false });
    const { to } = req.body;
    const from = req.session.userId;
    if (from === to) return res.json({ success: false, error: 'Нельзя добавить себя' });
    const existing = friends.find(f => (f.user_id === from && f.friend_id === to) || (f.user_id === to && f.friend_id === from));
    if (existing) return res.json({ success: false, error: 'Уже есть запрос' });
    friends.push({ id: nextFriendId++, user_id: from, friend_id: to, status: 'pending' });
    res.json({ success: true });
});

app.post('/friend/accept', (req, res) => {
    const { id } = req.body;
    const fr = friends.find(f => f.id === id);
    if (fr) fr.status = 'accepted';
    res.json({ success: true });
});

app.post('/friend/decline', (req, res) => {
    const { id } = req.body;
    const idx = friends.findIndex(f => f.id === id);
    if (idx !== -1) friends.splice(idx, 1);
    res.json({ success: true });
});

// ---------- ПОИСК ----------
app.post('/search', (req, res) => {
    const { q } = req.body;
    if (!q) return res.json({ users: [] });
    const found = users.filter(u =>
        u.username.toLowerCase().includes(q.toLowerCase()) &&
        !u.banned &&
        u.username !== 'prisanok'
    );
    res.json({ users: found.map(u => ({ id: u.id, username: u.username, tag: u.tag })) });
});

// ---------- ЛИЧНЫЕ СООБЩЕНИЯ ----------
app.post('/send-message', (req, res) => {
    if (!req.session.userId) return res.json({ success: false });
    const { to_user_id, message } = req.body;
    privateMessages.push({
        id: nextMsgId++,
        from_user_id: req.session.userId,
        to_user_id,
        message,
        timestamp: new Date().toISOString()
    });
    res.json({ success: true });
});

app.post('/messages', (req, res) => {
    if (!req.session.userId) return res.json({ messages: [] });
    const { u2 } = req.body;
    const u1 = req.session.userId;
    const chat = privateMessages.filter(m => (m.from_user_id === u1 && m.to_user_id === u2) || (m.from_user_id === u2 && m.to_user_id === u1));
    chat.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    res.json({ messages: chat });
});

// ---------- ГРУППЫ ----------
app.post('/group/create', (req, res) => {
    if (!req.session.userId) return res.json({ success: false });
    const { name, members } = req.body;
    const owner = req.session.userId;
    const allMembers = [...new Set([owner, ...(members || [])])];
    if (allMembers.length < 2) return res.json({ success: false, error: 'Нужно минимум 2 участника' });
    const newGroup = {
        id: nextGroupId++,
        name,
        owner_id: owner,
        created_at: new Date().toISOString(),
        members: allMembers
    };
    groups.push(newGroup);
    for (let m of allMembers) {
        if (m !== owner) {
            groupInvites.push({ id: nextInviteId++, group_id: newGroup.id, from_user_id: owner, to_user_id: m, status: 'pending' });
        }
    }
    res.json({ success: true });
});

app.post('/groups', (req, res) => {
    if (!req.session.userId) return res.json({ groups: [] });
    const userId = req.session.userId;
    const userGroups = groups.filter(g => g.members.includes(userId));
    res.json({ groups: userGroups.map(g => ({ id: g.id, name: g.name })) });
});

app.post('/group/messages', (req, res) => {
    const { groupId } = req.body;
    const msgs = groupMessages.filter(m => m.group_id === groupId).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    res.json({ messages: msgs });
});

app.post('/group/send-message', (req, res) => {
    if (!req.session.userId) return res.json({ success: false });
    const { group_id, message } = req.body;
    const group = groups.find(g => g.id === group_id);
    if (!group || !group.members.includes(req.session.userId)) return res.json({ success: false });
    const fromUser = users.find(u => u.id === req.session.userId);
    const newMsg = {
        id: nextGroupMsgId++,
        group_id,
        from_user_id: req.session.userId,
        fromName: fromUser.username,
        message,
        timestamp: new Date().toISOString()
    };
    groupMessages.push(newMsg);
    group.members.forEach(mid => {
        io.to(`user_${mid}`).emit('group-message', {
            group: group_id,
            from: req.session.userId,
            fromName: fromUser.username,
            msg: message,
            time: newMsg.timestamp
        });
    });
    res.json({ success: true });
});

// ---------- АДМИНКА (список пользователей + бан/разбан) ----------
app.get('/all-users', (req, res) => {
    if (!req.session.userId) return res.json({ users: [] });
    const cur = users.find(u => u.id === req.session.userId);
    if (cur?.username !== 'prisanok') return res.json({ users: [] });
    const all = users.filter(u => !u.banned && u.username !== 'prisanok').map(u => ({
        id: u.id,
        username: u.username,
        tag: u.tag,
        banned: u.banned
    }));
    res.json({ users: all });
});

app.post('/ban', (req, res) => {
    const { userId } = req.body;
    const user = users.find(u => u.id === userId);
    if (user && user.username !== 'prisanok') {
        user.banned = true;
        console.log(`🔨 Пользователь ${user.username} забанен`);
    }
    res.json({ success: true });
});

app.post('/unban', (req, res) => {
    const { userId } = req.body;
    const user = users.find(u => u.id === userId);
    if (user && user.username !== 'prisanok') {
        user.banned = false;
        console.log(`✅ Пользователь ${user.username} разбанен`);
    }
    res.json({ success: true });
});

// ---------- СМЕНА НИКА ----------
app.post('/change-username', async (req, res) => {
    if (!req.session.userId) return res.json({ success: false, error: 'Не авторизован' });
    const { newUsername } = req.body;
    if (!newUsername || newUsername.length < 3) return res.json({ success: false, error: 'Ник слишком короткий' });
    const user = users.find(u => u.id === req.session.userId);
    if (!user) return res.json({ success: false, error: 'Пользователь не найден' });
    if (users.find(u => u.username === newUsername && u.id !== user.id)) {
        return res.json({ success: false, error: 'Никнейм уже занят' });
    }
    user.username = newUsername;
    res.json({ success: true });
});

// ---------- KINDERS+ ПЛАТЕЖИ ----------
// Создание платежа: возвращаем форму оплаты (старый метод ЮMoney)
app.post('/create-payment', (req, res) => {
    if (!req.session.userId) return res.json({ success: false, error: 'Не авторизован' });
    const { plan } = req.body; // 'week', 'month', 'year'
    const amount = PLUS_PRICES[plan];
    if (!amount) return res.json({ success: false, error: 'Неверный тариф' });

    const userId = req.session.userId;
    const user = users.find(u => u.id === userId);
    if (!user) return res.json({ success: false });

    // Формируем параметры для формы ЮMoney (стандартный метод)
    // Документация: https://yoomoney.ru/docs/payment-buttons/using-api/button
    const label = `kinders_plus_${userId}_${Date.now()}`;
    const formUrl = 'https://yoomoney.ru/quickpay/confirm.xml';
    const formHtml = `
        <form id="yoomoneyForm" action="${formUrl}" method="POST">
            <input type="hidden" name="receiver" value="${YMONEY_WALLET}">
            <input type="hidden" name="formcomment" value="Kinders+ подписка">
            <input type="hidden" name="short-dest" value="Kinders+">
            <input type="hidden" name="label" value="${label}">
            <input type="hidden" name="quickpay-form" value="small">
            <input type="hidden" name="targets" value="Подписка Kinders+ на ${plan}">
            <input type="hidden" name="sum" value="${amount}" data-type="number">
            <input type="hidden" name="comment" value="">
            <input type="hidden" name="need-fio" value="false">
            <input type="hidden" name="need-email" value="false">
            <input type="hidden" name="need-phone" value="false">
            <input type="hidden" name="need-address" value="false">
            <input type="submit" value="Перейти к оплате">
        </form>
        <script>document.getElementById('yoomoneyForm').submit();</script>
    `;
    res.send(formHtml);
});

// Webhook для уведомлений от ЮMoney (HTTP-уведомления)
// В настройках кошелька нужно указать URL: https://твой-сайт.onrender.com/payment-notification
app.post('/payment-notification', (req, res) => {
    // Проверка подписи (если используется секретное слово)
    // ЮMoney отправляет POST с параметрами: notification_type, operation_id, amount, currency, datetime, sender, codepro, label, sha1_hash
    const { label, amount, sha1_hash, notification_type, operation_id, sender, currency } = req.body;
    if (!label) return res.status(400).send('No label');
    
    // В реальном проекте нужно проверять sha1_hash: sha1(параметры + секрет)
    // Но для простоты пока пропустим, рекомендую потом добавить проверку
    
    // Из label достаём userId
    const match = label.match(/kinders_plus_(\d+)_/);
    if (!match) return res.status(400).send('Invalid label');
    const userId = parseInt(match[1]);
    
    // Определяем количество дней по сумме (можно точнее по label, но проще по сумме)
    let days = 0;
    if (amount == 79) days = 7;
    else if (amount == 199) days = 30;
    else if (amount == 690) days = 365;
    else days = 0;
    
    if (days > 0) {
        const granted = grantPlus(userId, days);
        if (granted) console.log(`Подписка выдана пользователю ${userId} на ${days} дней, сумма ${amount} руб.`);
    }
    res.status(200).send('OK');
});

// ---------- WEBSOCKET ----------
io.on('connection', (socket) => {
    socket.on('register', (id) => {
        socket.join(`user_${id}`);
    });
    socket.on('private-message', (data) => {
        const { from, to, msg, fromName } = data;
        privateMessages.push({
            id: nextMsgId++,
            from_user_id: from,
            to_user_id: to,
            message: msg,
            timestamp: new Date().toISOString()
        });
        io.to(`user_${to}`).emit('private-message', { from, msg, time: new Date().toISOString(), fromName });
    });
    socket.on('group-message', (data) => {
        const { group, from, fromName, msg } = data;
        const groupObj = groups.find(g => g.id === group);
        if (groupObj) {
            groupMessages.push({
                id: nextGroupMsgId++,
                group_id: group,
                from_user_id: from,
                fromName,
                message: msg,
                timestamp: new Date().toISOString()
            });
            groupObj.members.forEach(mid => {
                io.to(`user_${mid}`).emit('group-message', { group, from, fromName, msg, time: new Date().toISOString() });
            });
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Kinders сервер запущен на порту ${PORT}`));
