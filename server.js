const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.express = express;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8816726564:AAG3ETwx98oBfjDV8I-BipzEXGZCnJPFezg";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "371093083";

const claimedWelcomeBonusUsers = new Set();
let globalRoom = {
    gameActive: false,
    playersCount: 140,
    currentMultiplier: 1.00,
    crashPoint: 2.00
};

let aviatorInterval = null;
let gameLoopInterval = null;
let connectedRealPlayers = [];
let onlineRealUsers = [];
let pendingRequests = {};
let offlineApprovedQueue = {};

const ETHIOPIAN_BOT_NAMES = [
    "Henok", "Dani", "Simret Getachew", "Anwar", "Beki", "Abel x", 
    "Meron W.", "Yohannes Ng", "Tedi", "Samii", "Miki_Aviator", "Hanna T."
];

function getRealisticBotsCount(realCount, isGameActive = false) {
    return isGameActive ? 120 + Math.floor(Math.random() * 30) : 85 + Math.floor(Math.random() * 15);
}

// 🚀 የ AZ Avatar ዋና የጨዋታ ዑደት (Crash Game Logic)
function startAvatarGameLoop() {
    if (gameLoopInterval) clearInterval(gameLoopInterval);

    // ከዋናው ጨዋታ በፊት የ 8 ሰከንድ መዘግየት (Waiting for bets)
    globalRoom.gameActive = false;
    globalRoom.currentMultiplier = 1.00;
    io.emit('gameWaiting', { nextIn: 8000 });

    setTimeout(() => {
        globalRoom.gameActive = true;
        globalRoom.currentMultiplier = 1.00;
        
        // አውሮፕላኑ የሚበላበትን ነጥብ በዘፈቀደ እንመርጣለን (ለምሳሌ ከ 1.20x እስከ 10.00x)
        // 80 በመቶ ጊዜ ዝቅተኛ/መካከለኛ, 20 በመቶ ጊዜ ከፍ ያለ ማልቲፕላየር ይኖረዋል
        let rand = Math.random();
        if (rand < 0.60) {
            globalRoom.crashPoint = Number((1.10 + Math.random() * 1.80).toFixed(2)); // 1.10x - 2.90x
        } else if (rand < 0.90) {
            globalRoom.crashPoint = Number((3.00 + Math.random() * 4.00).toFixed(2)); // 3.00x - 7.00x
        } else {
            globalRoom.crashPoint = Number((7.01 + Math.random() * 15.00).toFixed(2)); // 7.01x - 22.00x
        }

        io.emit('gameStarted', { crashPoint: globalRoom.crashPoint });

        if (aviatorInterval) clearInterval(aviatorInterval);

        // ማልቲፕላየሩ በሰከንድ ሰከንድ እየጨመረ ይሄዳል
        aviatorInterval = setInterval(() => {
            if (!globalRoom.gameActive) {
                clearInterval(aviatorInterval);
                return;
            }

            // ፍጥነቱ እየጨመረ ሲሄድ ጭማሪውም እየሰፋ ይሄዳል
            let increment = globalRoom.currentMultiplier < 2.0 ? 0.02 : (globalRoom.currentMultiplier < 5.0 ? 0.05 : 0.12);
            globalRoom.currentMultiplier = Number((globalRoom.currentMultiplier + increment).toFixed(2));

            io.emit('avatarTick', { multiplier: globalRoom.currentMultiplier });

            // ✈️ አውሮፕላኑ ሲከሰክስ (Crash ሲያደርግ)
            if (globalRoom.currentMultiplier >= globalRoom.crashPoint) {
                globalRoom.gameActive = false;
                clearInterval(aviatorInterval);
                io.emit('avatarCrashed', { crashedAt: globalRoom.crashPoint });

                // ከ 6 ሰከንድ በኋላ አዲስ ዙር ይጀምራል
                setTimeout(() => {
                    startAvatarGameLoop();
                }, 6000);
            }
        }, 150);

    }, 8000);
}

io.on('connection', (socket) => {
    connectedRealPlayers.push(socket.id);
    let realCount = connectedRealPlayers.length;
    globalRoom.playersCount = getRealisticBotsCount(realCount, globalRoom.gameActive) + realCount;
    
    socket.emit('syncGameState', globalRoom);
    io.emit('updatePlayersCount', globalRoom.playersCount);

    socket.on('registerRealUser', (userData) => {
        if (userData && userData.userId) {
            let userId = String(userData.userId);
            onlineRealUsers = onlineRealUsers.filter(u => u.userId !== userId);
            onlineRealUsers.push({ socketId: socket.id, userId: userId, username: userData.username || 'AZ Player' });
            
            if (!claimedWelcomeBonusUsers.has(userId)) {
                claimedWelcomeBonusUsers.add(userId);
                socket.emit('welcomeBonusGranted', { amount: 20, message: "እንኳን ደህና መጡ! የ 20 ብር ቦነስ ተሰጥቷል!" });
            }
        }
    });

    // 💰 ተጫዋቹ Cash Out ሲያደርግ የሚሰላ ሎጂክ
    socket.on('playerCashOut', (data) => {
        if (!globalRoom.gameActive) {
            socket.emit('cashOutError', { message: "ጨዋታው አልጀመረም ወይም አብቅቷል!" });
            return;
        }

        let betAmount = Number(data.betAmount) || 10;
        let cashMultiplier = globalRoom.currentMultiplier;
        let wonPrize = Math.floor(betAmount * cashMultiplier);

        socket.emit('cashOutSuccess', {
            multiplier: cashMultiplier.toFixed(2),
            wonAmount: wonPrize,
            message: `🎉 እንኳን ደስ አለዎት! በ ${cashMultiplier.toFixed(2)}x ${wonPrize} ብር አሸንፈዋል!`
        });
    });

    socket.on('financialRequest', async (data) => {
        data.type = data.type || 'deposit';
        let { type, amount, username, userId, currentBalance, phone, receipt } = data;
        let requestId = 'req_' + socket.id.substring(0, 5) + '_' + Date.now();
        
        pendingRequests[requestId] = { userId, type, amount, username, socketId: socket.id, timestamp: Date.now() };

        if (TELEGRAM_BOT_TOKEN && ADMIN_CHAT_ID) {
            let message = `🔔 *AZ AVATOR - የገንዘብ ጥያቄ*\n\n👤 ስም: *${username}*\n💰 መጠን: *${amount} ብር*\n📱 ስልክ: ${phone || 'አልተሰጠም'}`;
            try {
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: ADMIN_CHAT_ID, text: message, parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: "✅ አጽድቅ", callback_data: "app_" + requestId }, { text: "❌ ሰርዝ", callback_data: "rej_" + requestId }]] }
                });
            } catch (e) {}
        }
        socket.emit('requestSubmitted', { success: true, message: "✅ ጥያቄዎ ለአድሚን ተልኳል!" });
    });

    socket.on('disconnect', () => {
        connectedRealPlayers = connectedRealPlayers.filter(id => id !== socket.id);
        onlineRealUsers = onlineRealUsers.filter(u => u.socketId !== socket.id);
        globalRoom.playersCount = getRealisticBotsCount(connectedRealPlayers.length, globalRoom.gameActive) + connectedRealPlayers.length;
        io.emit('updatePlayersCount', globalRoom.playersCount);
    });
});

startAvatarGameLoop();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log("AZ Avatar Server running on port " + PORT);
});
