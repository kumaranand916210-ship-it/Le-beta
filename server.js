const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

// ==================== CONFIG ====================
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'aviate-game-secret-key-2025';
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://username:password@cluster.xxxxx.mongodb.net/aviator?retryWrites=true&w=majority';

// UPI Config - Admin set karega
let UPI_ID = '7903368331@fam';
let UPI_NAME = 'AVIATOR GAME';

// ==================== APP SETUP ====================
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());

// ==================== MONGOOSE MODELS ====================
const userSchema = new mongoose.Schema({
  phone: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  balance: { type: Number, default: 0 },
  bonusBalance: { type: Number, default: 0 },
  totalDeposited: { type: Number, default: 0 },
  totalWithdrawn: { type: Number, default: 0 },
  firstDepositDone: { type: Boolean, default: false },
  gamesPlayed: { type: Number, default: 0 },
  referralCode: { type: String, unique: true },
  referredBy: { type: String, default: null },
  referralCount: { type: Number, default: 0 },
  lastLoginBonus: { type: Date, default: null },
  welcomeBonusClaimed: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  isAdmin: { type: Boolean, default: false }
});

const depositSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  phone: String,
  amount: Number,
  utr: { type: String, unique: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  approvedAt: { type: Date }
});

const withdrawSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  phone: String,
  amount: Number,
  upiId: String,
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  approvedAt: { type: Date }
});

const settlementSchema = new mongoose.Schema({
  roundNumber: { type: Number, required: true },
  crashPoint: { type: Number, required: true },
  totalBets: { type: Number, default: 0 },
  houseProfit: { type: Number, default: 0 },
  timestamp: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Deposit = mongoose.model('Deposit', depositSchema);
const Withdraw = mongoose.model('Withdraw', withdrawSchema);
const Settlement = mongoose.model('Settlement', settlementSchema);

// ==================== AUTH MIDDLEWARE ====================
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    req.userId = decoded.id;
    req.phone = decoded.phone;
    req.isAdmin = decoded.isAdmin || false;
    next();
  } catch(e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function adminMiddleware(req, res, next) {
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ==================== GENERATE REFERRAL CODE ====================
function generateReferralCode(phone) {
  return 'AV' + phone.slice(-5) + Math.random().toString(36).slice(2, 5).toUpperCase();
}

// ==================== ROUND STATE ====================
let roundActive = false;
let lockPeriod = false;
let currentMultiplier = 0;
let crashPoint = 1;
let roundNumber = 0;
let betPool = [];
let allPlayers = [];
let roundHistory = [];
let countdownTimer = null;

function generateCrashPoint() {
  const r = Math.random();
  let cp;
  if (r < 0.05) cp = 1 + Math.random() * 0.5;       // 5% chance: 1.00-1.50
  else if (r < 0.25) cp = 1.5 + Math.random() * 1.5; // 20% chance: 1.50-3.00
  else if (r < 0.55) cp = 3 + Math.random() * 4;     // 30% chance: 3.00-7.00
  else if (r < 0.80) cp = 7 + Math.random() * 8;     // 25% chance: 7.00-15.00
  else if (r < 0.95) cp = 15 + Math.random() * 35;    // 15% chance: 15.00-50.00
  else cp = 50 + Math.random() * 50 + Math.random() * 100; // 5% chance: 50.00-200.00
  return Math.round(cp * 100) / 100;
}

function startRound() {
  if (roundActive) return;
  roundActive = true;
  lockPeriod = false;
  currentMultiplier = 0;
  crashPoint = generateCrashPoint();
  roundNumber++;
  betPool = [];
  allPlayers = [];

  console.log(`🛩️ Round #${roundNumber} started. Crash at: ${crashPoint}x`);

  io.emit('roundStart', { crashPoint, roundNumber });
  io.emit('lockPeriod');

  // 3 second lock period
  setTimeout(() => {
    lockPeriod = false;
    io.emit('unlockPeriod');
    
    // Start multiplier
    const interval = setInterval(() => {
      if (!roundActive) { clearInterval(interval); return; }
      
      currentMultiplier += 0.01;
      currentMultiplier = Math.round(currentMultiplier * 100) / 100;
      
      io.emit('multiplierUpdate', { multiplier: currentMultiplier, isLocked: false });

      // Crash check
      if (currentMultiplier >= crashPoint) {
        endRound();
        clearInterval(interval);
      }
    }, 50);
  }, 3000);

  // Auto cashout check for players
  // (handled client-side, server validates)
}

function endRound() {
  roundActive = false;
  lockPeriod = false;
  
  // Process all unsettled bets (those who didn't cashout)
  let houseProfit = 0;
  betPool.forEach(bet => {
    if (!bet.cashedOut) {
      // Player lost - house wins
      houseProfit += bet.amount;
    }
  });

  // Save settlement
  const settlement = new Settlement({
    roundNumber,
    crashPoint,
    totalBets: betPool.length,
    houseProfit
  });
  settlement.save().catch(e => console.error('Settlement save error:', e));

  // Update history
  roundHistory.unshift({ crashPoint });
  if (roundHistory.length > 100) roundHistory.pop();

  console.log(`💥 Round #${roundNumber} crashed at ${crashPoint}x. House: +₹${houseProfit}`);

  io.emit('roundEnd', { crashPoint, roundNumber, roundHistory });

  // Wait then start next round
  setTimeout(startRound, 5000);
}

// ==================== REST API ====================

// --- AUTH ---
app.post('/register', async (req, res) => {
  try {
    const { phone, password, referralCode } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });
    if (phone.length !== 10) return res.status(400).json({ error: '10-digit phone required' });

    const existing = await User.findOne({ phone });
    if (existing) return res.status(400).json({ error: 'Phone already registered. Login karein.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const refCode = generateReferralCode(phone);

    // Referral bonus for referrer
    let referrer = null;
    if (referralCode) {
      referrer = await User.findOne({ referralCode });
      if (referrer) {
        // Referrer ko bonus
        const refBonus = Math.floor(Math.random() * 101) + 100; // ₹100-₹200
        referrer.bonusBalance += refBonus;
        referrer.referralCount += 1;
        await referrer.save();
      }
    }

    // Welcome bonus
    const welcomeBonus = Math.floor(Math.random() * 191) + 10; // ₹10-₹200

    const user = new User({
      phone,
      password: hashedPassword,
      referralCode: refCode,
      referredBy: referralCode || null,
      bonusBalance: welcomeBonus,
      welcomeBonusClaimed: true
    });
    await user.save();

    // Referred person ko ₹10 bonus
    if (referrer) {
      await User.findByIdAndUpdate(user._id, { $inc: { bonusBalance: 10 } });
    }

    const token = jwt.sign({ id: user._id, phone: user.phone, isAdmin: user.isAdmin }, JWT_SECRET);
    
    res.json({
      token,
      user: {
        balance: user.balance,
        bonusBalance: user.bonusBalance + (referrer ? 10 : 0),
        referralCode: refCode,
        referralCount: 0,
        firstDepositDone: false,
        totalDeposited: 0,
        welcomeBonus: welcomeBonus
      }
    });
  } catch(e) {
    console.error('Register error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });

    const user = await User.findOne({ phone });
    if (!user) return res.status(400).json({ error: 'Account nahi mila. Register karein.' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Wrong password' });

    // Daily login bonus
    let loginBonus = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const lastBonus = user.lastLoginBonus ? new Date(user.lastLoginBonus) : null;
    
    if (!lastBonus || lastBonus < today) {
      loginBonus = Math.floor(Math.random() * 191) + 10; // ₹10-₹200
      user.bonusBalance += loginBonus;
      user.lastLoginBonus = new Date();
      await user.save();
    }

    const token = jwt.sign({ id: user._id, phone: user.phone, isAdmin: user.isAdmin }, JWT_SECRET);
    
    res.json({
      token,
      user: {
        balance: user.balance,
        bonusBalance: user.bonusBalance,
        referralCode: user.referralCode,
        referralCount: user.referralCount,
        firstDepositDone: user.firstDepositDone,
        totalDeposited: user.totalDeposited,
        loginBonus
      }
    });
  } catch(e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- GET BALANCE ---
app.get('/balance', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      balance: user.balance,
      bonusBalance: user.bonusBalance,
      referralCode: user.referralCode,
      referralCount: user.referralCount,
      firstDepositDone: user.firstDepositDone,
      totalDeposited: user.totalDeposited,
      gamesPlayed: user.gamesPlayed
    });
  } catch(e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// --- DEPOSIT REQUEST (USER submits UTR) ---
app.post('/deposit', authMiddleware, async (req, res) => {
  try {
    const { amount, utr } = req.body;
    if (!amount || amount < 5) return res.status(400).json({ error: 'Minimum ₹5 deposit' });
    if (!utr) return res.status(400).json({ error: 'UTR number required' });

    const existingDeposit = await Deposit.findOne({ utr });
    if (existingDeposit) return res.status(400).json({ error: 'Ye UTR pehle use ho chuka hai' });

    const deposit = new Deposit({
      userId: req.userId,
      phone: req.phone,
      amount,
      utr,
      status: 'pending'
    });
    await deposit.save();

    console.log(`💰 Deposit request: ${req.phone} → ₹${amount} (UTR: ${utr})`);

    res.json({ success: true, message: 'Deposit request submitted. Admin approve karega!' });
  } catch(e) {
    console.error('Deposit error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- WITHDRAW REQUEST ---
app.post('/withdraw', authMiddleware, async (req, res) => {
  try {
    const { amount, upiId } = req.body;
    if (!amount || amount < 50) return res.status(400).json({ error: 'Minimum ₹50 withdraw' });
    if (amount > 50000) return res.status(400).json({ error: 'Maximum ₹50,000 per withdraw' });
    if (!upiId) return res.status(400).json({ error: 'UPI ID required' });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Withdrawal eligibility check
    if (user.totalDeposited < 100 && !user.firstDepositDone) {
      return res.status(400).json({ error: '₹100 deposit karke khelne ke baad hi withdrawal hoga' });
    }
    if (user.gamesPlayed < 1) {
      return res.status(400).json({ error: 'Kam se kam 1 game khelna hoga withdrawal ke liye' });
    }
    if (user.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Freeze balance
    user.balance -= amount;
    await user.save();

    const withdraw = new Withdraw({
      userId: req.userId,
      phone: req.phone,
      amount,
      upiId,
      status: 'pending'
    });
    await withdraw.save();

    console.log(`🏧 Withdraw request: ${req.phone} → ₹${amount} to ${upiId}`);

    res.json({ success: true, message: 'Withdraw request submitted. Admin approve karega!' });
  } catch(e) {
    console.error('Withdraw error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- GET UPI DETAILS (for frontend) ---
app.get('/payment-details', authMiddleware, async (req, res) => {
  res.json({ upiId: UPI_ID, upiName: UPI_NAME });
});

// ==================== ADMIN API ====================

// --- Admin Login ---
app.post('/admin/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const user = await User.findOne({ phone, isAdmin: true });
    if (!user) return res.status(403).json({ error: 'Admin access denied' });
    
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(403).json({ error: 'Wrong password' });

    const token = jwt.sign({ id: user._id, phone: user.phone, isAdmin: true }, JWT_SECRET);
    res.json({ token });
  } catch(e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// --- GET PENDING DEPOSITS ---
app.get('/admin/deposits', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const deposits = await Deposit.find({ status }).sort({ createdAt: -1 }).limit(100);
    res.json({ deposits });
  } catch(e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// --- APPROVE DEPOSIT (ADMIN) ---
app.post('/admin/deposit/approve', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { depositId } = req.body;
    const deposit = await Deposit.findById(depositId);
    if (!deposit) return res.status(404).json({ error: 'Deposit not found' });
    if (deposit.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    deposit.status = 'approved';
    deposit.approvedAt = new Date();
    await deposit.save();

    // Add to user balance (with 10% bonus)
    const bonus = Math.round(deposit.amount * 0.1);
    const user = await User.findById(deposit.userId);
    user.balance += deposit.amount;
    user.bonusBalance += bonus;
    user.totalDeposited += deposit.amount;
    user.firstDepositDone = true;
    await user.save();

    console.log(`✅ Deposit APPROVED: ${deposit.phone} → ₹${deposit.amount} (+₹${bonus} bonus)`);

    // Notify user via socket if connected
    const socketEntry = [...io.sockets.sockets.values()].find(s => s.userId?.toString() === deposit.userId?.toString());
    if (socketEntry) {
      socketEntry.emit('depositApproved', { amount: deposit.amount, bonus, balance: user.balance, bonusBalance: user.bonusBalance });
    }

    res.json({ success: true, message: `Deposit approved! ₹${deposit.amount} + ₹${bonus} bonus added` });
  } catch(e) {
    console.error('Approve deposit error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- REJECT DEPOSIT (ADMIN) ---
app.post('/admin/deposit/reject', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { depositId } = req.body;
    const deposit = await Deposit.findById(depositId);
    if (!deposit) return res.status(404).json({ error: 'Deposit not found' });

    deposit.status = 'rejected';
    await deposit.save();

    console.log(`❌ Deposit REJECTED: ${deposit.phone} (₹${deposit.amount})`);

    res.json({ success: true, message: 'Deposit rejected' });
  } catch(e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// --- GET PENDING WITHDRAWS ---
app.get('/admin/withdraws', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const withdraws = await Withdraw.find({ status }).sort({ createdAt: -1 }).limit(100);
    res.json({ withdraws });
  } catch(e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// --- APPROVE WITHDRAW (ADMIN) ---
app.post('/admin/withdraw/approve', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { withdrawId } = req.body;
    const withdraw = await Withdraw.findById(withdrawId);
    if (!withdraw) return res.status(404).json({ error: 'Withdraw not found' });

    withdraw.status = 'approved';
    withdraw.approvedAt = new Date();
    await withdraw.save();

    console.log(`✅ Withdraw APPROVED: ${withdraw.phone} → ₹${withdraw.amount} to ${withdraw.upiId}`);

    const user = await User.findById(withdraw.userId);
    if (user) {
      const socketEntry = [...io.sockets.sockets.values()].find(s => s.userId?.toString() === user._id?.toString());
      if (socketEntry) {
        socketEntry.emit('withdrawApproved', { amount: withdraw.amount, balance: user.balance });
      }
    }

    res.json({ success: true, message: 'Withdraw approved! Payment karein.' });
  } catch(e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// --- GET ALL USERS (ADMIN) ---
app.get('/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const users = await User.find({}, '-password').sort({ createdAt: -1 }).limit(200);
    res.json({ users });
  } catch(e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// --- UPDATE UPI DETAILS (ADMIN) ---
app.post('/admin/upi/update', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { upiId, upiName } = req.body;
    if (upiId) UPI_ID = upiId;
    if (upiName) UPI_NAME = upiName;
    res.json({ success: true, message: 'UPI details updated!' });
  } catch(e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// --- GET STATS (ADMIN) ---
app.get('/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalDeposits = await Deposit.aggregate([
      { $match: { status: 'approved' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const totalWithdraws = await Withdraw.aggregate([
      { $match: { status: 'approved' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const pendingDeposits = await Deposit.countDocuments({ status: 'pending' });
    const pendingWithdraws = await Withdraw.countDocuments({ status: 'pending' });

    res.json({
      totalUsers,
      totalDeposits: totalDeposits[0]?.total || 0,
      totalWithdraws: totalWithdraws[0]?.total || 0,
      pendingDeposits,
      pendingWithdraws
    });
  } catch(e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// --- MANUALLY ADD BALANCE TO USER (ADMIN) ---
app.post('/admin/user/add-balance', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { phone, amount, type } = req.body; // type: 'real' or 'bonus'
    if (!phone || !amount) return res.status(400).json({ error: 'Phone and amount required' });

    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (type === 'bonus') {
      user.bonusBalance += amount;
    } else {
      user.balance += amount;
    }
    await user.save();

    const socketEntry = [...io.sockets.sockets.values()].find(s => s.userId?.toString() === user._id?.toString());
    if (socketEntry) {
      socketEntry.emit('balanceUpdate', { balance: user.balance, bonusBalance: user.bonusBalance });
    }

    res.json({ success: true, message: `₹${amount} added to ${phone} (${type || 'real'})` });
  } catch(e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== SOCKET.IO GAME LOGIC ====================

// Generate unique short user id
function generateShortId() {
  return '#' + Math.random().toString(36).slice(2, 7).toUpperCase();
}

io.on('connection', (socket) => {
  console.log(`🔗 New connection: ${socket.id}`);

  socket.on('joinGame', async (data) => {
    try {
      const decoded = jwt.verify(data.token, JWT_SECRET);
      const user = await User.findById(decoded.id);
      if (!user) {
        socket.emit('error', { message: 'User not found' });
        return;
      }

      socket.userId = user._id;
      socket.phone = user.phone;
      socket.displayId = generateShortId();
      socket.betAmount = 0;
      socket.cashedOut = false;
      socket.cashedOutAt = 0;

      socket.emit('gameState', {
        isRoundActive: roundActive,
        currentMultiplier: roundActive ? currentMultiplier : 0,
        crashPoint: roundActive ? crashPoint : (roundHistory[0]?.crashPoint || 1),
        roundNumber,
        roundHistory: roundHistory.slice(0, 15),
        balance: user.balance,
        bonusBalance: user.bonusBalance,
        referralCode: user.referralCode,
        referralCount: user.referralCount,
        firstDepositDone: user.firstDepositDone,
        totalDeposited: user.totalDeposited
      });

      io.emit('allPlayers', { players: getAllPlayersData() });
      console.log(`✅ ${user.phone} joined as ${socket.displayId}`);

    } catch(e) {
      socket.emit('error', { message: 'Invalid token' });
    }
  });

  socket.on('placeBet', async (data) => {
    try {
      if (!roundActive || lockPeriod) {
        return socket.emit('error', { message: 'Round not active or locked' });
      }
      if (!socket.userId) return;

      const user = await User.findById(socket.userId);
      if (!user) return;

      const amount = parseInt(data.amount);
      if (!amount || amount < 1) return;

      // Use real balance first, then bonus
      let deductedFromReal = 0;
      let deductedFromBonus = 0;

      if (user.balance >= amount) {
        user.balance -= amount;
        deductedFromReal = amount;
      } else if (user.balance + user.bonusBalance >= amount) {
        deductedFromReal = user.balance;
        deductedFromBonus = amount - user.balance;
        user.balance = 0;
        user.bonusBalance -= deductedFromBonus;
      } else {
        return socket.emit('error', { message: 'Insufficient balance' });
      }

      socket.betAmount = amount;
      socket.cashedOut = false;
      socket.cashedOutAt = 0;

      betPool.push({
        userId: user._id,
        socketId: socket.id,
        amount,
        deductedFromReal,
        deductedFromBonus,
        cashedOut: false,
        cashedOutAt: 0
      });

      // Update player list
      const existing = allPlayers.find(p => p.socketId === socket.id);
      if (!existing) {
        allPlayers.push({ socketId: socket.id, uid: socket.displayId, betAmount: amount, isCashedOut: false, cashedOutAt: 0 });
      } else {
        existing.betAmount = amount;
        existing.isCashedOut = false;
        existing.cashedOutAt = 0;
      }

      user.gamesPlayed += 1;
      await user.save();

      io.emit('allPlayers', { players: getAllPlayersData() });
      socket.emit('betPlaced', { amount, balance: user.balance, bonusBalance: user.bonusBalance });

      console.log(`🎲 ${user.phone} bet ₹${amount} (R:${deductedFromReal} B:${deductedFromBonus})`);

    } catch(e) {
      console.error('Bet error:', e);
      socket.emit('error', { message: 'Bet failed' });
    }
  });

  socket.on('cashout', async () => {
    try {
      if (!socket.userId || !roundActive) return;
      if (!socket.betAmount || socket.cashedOut) return;

      const bet = betPool.find(b => b.socketId === socket.id);
      if (!bet) return;

      const cashoutMult = currentMultiplier;
      const winAmount = Math.round(bet.amount * cashoutMult);
      
      const user = await User.findById(socket.userId);
      if (!user) return;

      // Calculate how much goes to real vs bonus
      const totalIn = bet.deductedFromReal + bet.deductedFromBonus;
      const ratioReal = totalIn > 0 ? bet.deductedFromReal / totalIn : 0;
      const ratioBonus = totalIn > 0 ? bet.deductedFromBonus / totalIn : 0;

      const winToReal = Math.round(winAmount * ratioReal);
      const winToBonus = Math.round(winAmount * ratioBonus);

      user.balance += winToReal;
      user.bonusBalance += winToBonus;

      bet.cashedOut = true;
      bet.cashedOutAt = cashoutMult;
      socket.cashedOut = true;
      socket.cashedOutAt = cashoutMult;

      // Update player list
      const player = allPlayers.find(p => p.socketId === socket.id);
      if (player) {
        player.isCashedOut = true;
        player.cashedOutAt = cashoutMult;
      }

      await user.save();
      io.emit('allPlayers', { players: getAllPlayersData() });

      socket.emit('cashoutSuccess', {
        multiplier: cashoutMult,
        winAmount,
        balance: user.balance,
        bonusBalance: user.bonusBalance
      });

      console.log(`💰 ${user.phone} cashed at ${cashoutMult}x → +₹${winAmount}`);

    } catch(e) {
      console.error('Cashout error:', e);
      socket.emit('error', { message: 'Cashout failed' });
    }
  });

  socket.on('disconnect', () => {
    allPlayers = allPlayers.filter(p => p.socketId !== socket.id);
    io.emit('allPlayers', { players: getAllPlayersData() });
    console.log(`🔌 Disconnected: ${socket.id}`);
  });
});

function getAllPlayersData() {
  return allPlayers.map(p => ({
    uid: p.uid,
    betAmount: p.betAmount,
    isCashedOut: p.isCashedOut,
    cashedOutAt: p.cashedOutAt
  }));
}

// ==================== START SERVER ====================
mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('✅ MongoDB connected');
    
    // Create default admin if not exists
    User.findOne({ phone: '9999999999' }).then(async (admin) => {
      if (!admin) {
        const hash = await bcrypt.hash('admin123', 10);
        await User.create({
          phone: '9999999999',
          password: hash,
          balance: 100000,
          isAdmin: true,
          referralCode: 'ADMIN001'
        });
        console.log('👑 Default admin created: 9999999999 / admin123');
      }
    });

    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      startRound();
    });
  })
  .catch(e => {
    console.error('MongoDB connection error:', e);
  });
