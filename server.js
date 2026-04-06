const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Хранилище пользователей
const users = [];
const messages = [];

// Регистрация
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  
  if (users.find(u => u.username === username)) {
    return res.status(400).json({ error: 'Пользователь уже существует' });
  }
  
  const hashedPassword = await bcrypt.hash(password, 10);
  users.push({ username, password: hashedPassword });
  
  const token = jwt.sign({ username }, process.env.JWT_SECRET);
  res.json({ token, username });
});

// Вход
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username);
  
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(400).json({ error: 'Неверное имя или пароль' });
  }
  
  const token = jwt.sign({ username }, process.env.JWT_SECRET);
  res.json({ token, username });
});

// Получить историю сообщений
app.get('/messages', (req, res) => {
  res.json(messages);
});

// WebSocket для чата
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Нет токена'));
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.username = decoded.username;
    next();
  } catch (err) {
    next(new Error('Неверный токен'));
  }
});

io.on('connection', (socket) => {
  console.log(`${socket.username} подключился к Kinders`);
  
  socket.emit('history', messages);
  socket.broadcast.emit('user_joined', `${socket.username} присоединился к Kinders`);
  
  socket.on('send_message', (text) => {
    const message = {
      username: socket.username,
      text: text,
      time: new Date().toLocaleTimeString(),
      id: Date.now()
    };
    messages.push(message);
    io.emit('new_message', message);
  });
  
  socket.on('disconnect', () => {
    io.emit('user_left', `${socket.username} покинул Kinders`);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Kinders сервер запущен на порту ${PORT}`);
});
