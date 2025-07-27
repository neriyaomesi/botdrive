const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    isJidBroadcast,
    fetchLatestBaileysVersion,
    Browsers,
    isJidGroup,
    downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const linkify = require("linkify-it")();

const WARNINGS_FILE = "./warnings.json";
const ADMINS = ["972508626144@s.whatsapp.net", "972537666943@s.whatsapp.net"]; // מספרים שמותר להם גם בפרטי
const OWNER = "972515961649@s.whatsapp.net";

// קבועים
const OWNER_NUMBER = "972515961649";
const ADMINS_FILE = path.join("admins.json");
const COMMANDS_FILE = path.join("commands.json");
const AUTH_DIR = "./auth_info_baileys";

// טען אזהרות קיימות
let warnings = {};
if (fs.existsSync(WARNINGS_FILE)) {
    warnings = JSON.parse(fs.readFileSync(WARNINGS_FILE));
}

// יצירת תיקיות נתונים
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// מניעת עיבוד כפול של הודעות
const processedMessages = new Set();
const MAX_PROCESSED_MESSAGES = 1000;

// פונקציות עזר לנהל נתונים
let admins = [];
let commands = {};
let dataLoaded = false;

function loadData() {
    if (dataLoaded) return;
    try {
        if (fs.existsSync(ADMINS_FILE)) {
            admins = JSON.parse(fs.readFileSync(ADMINS_FILE, "utf8"));
        }
        if (fs.existsSync(COMMANDS_FILE)) {
            commands = JSON.parse(fs.readFileSync(COMMANDS_FILE, "utf8"));
        }
        dataLoaded = true;
        console.log("✅ נתונים נטענו בהצלחה");
    } catch (error) {
        console.error("❌ שגיאה בטעינת נתונים:", error);
    }
}

function saveAdmins() {
    try {
        fs.writeFileSync(ADMINS_FILE, JSON.stringify(admins, null, 2));
        return true;
    } catch (error) {
        console.error("❌ שגיאה בשמירת מנהלים:", error);
        return false;
    }
}

function saveCommands() {
    try {
        fs.writeFileSync(COMMANDS_FILE, JSON.stringify(commands, null, 2));
        return true;
    } catch (error) {
        console.error("❌ שגיאה בשמירת פקודות:", error);
        return false;
    }
}

// טעינת נתונים בהתחלה
loadData();

// מערכת מצבים עם ניקוי אוטומטי
const userStates = new Map();
const STATE_TIMEOUT = 5 * 60 * 1000; // 5 דקות

function setState(userId, state) {
    userStates.set(userId, { ...state, timestamp: Date.now() });
}

function getState(userId) {
    const state = userStates.get(userId);
    if (state && Date.now() - state.timestamp > STATE_TIMEOUT) {
        userStates.delete(userId);
        return null;
    }
    return state;
}

function clearState(userId) {
    userStates.delete(userId);
}

// ניקוי מצבים ישנים כל דקה
setInterval(() => {
    const now = Date.now();
    for (const [userId, state] of userStates) {
        if (now - state.timestamp > STATE_TIMEOUT) {
            userStates.delete(userId);
        }
    }
}, 60000);

// פונקציות ניהול מנהלים
function cleanNumber(number) {
    return number.replace(/[^\d]/g, "");
}

function isOwner(number) {
    return cleanNumber(number) === OWNER_NUMBER.replace(/[^\d]/g, "");
}

function isAdmin(number) {
    const cleanNum = cleanNumber(number);
    return admins.includes(cleanNum) || isOwner(number);
}

function addAdmin(number) {
    const cleanNum = cleanNumber(number);
    if (!admins.includes(cleanNum) && !isOwner(number)) {
        admins.push(cleanNum);
        return saveAdmins();
    }
    return false;
}

function removeAdmin(number) {
    const cleanNum = cleanNumber(number);
    const index = admins.indexOf(cleanNum);
    if (index > -1) {
        admins.splice(index, 1);
        return saveAdmins();
    }
    return false;
}

// פונקציות ניהול פקודות
function addCommand(name, response) {
    commands[name] = response;
    return saveCommands();
}

function removeCommand(name) {
    if (commands[name]) {
        delete commands[name];
        return saveCommands();
    }
    return false;
}

function editCommand(name, newResponse) {
    if (commands[name]) {
        commands[name] = newResponse;
        return saveCommands();
    }
    return false;
}

// פונקציית reply עם error handling משופר
async function reply(sock, message, text) {
    try {
        if (!sock || !message?.key?.remoteJid) {
            console.error("❌ פרמטרים חסרים לשליחת הודעה");
            return false;
        }

        await sock.sendMessage(
            message.key.remoteJid,
            { text },
            { quoted: message },
        );
        connectionQuality.messagesSent++;
        return true;
    } catch (error) {
        console.error("❌ שגיאה בשליחת הודעה:", error.message);
        connectionQuality.errors.push({
            time: Date.now(),
            error: error.message,
            type: "message_send",
        });
        return false;
    }
}

// מניעת עיבוד הודעות כפול
function shouldProcessMessage(messageId) {
    if (!messageId || processedMessages.has(messageId)) {
        return false;
    }

    processedMessages.add(messageId);

    // ניקוי זיכרון
    if (processedMessages.size > MAX_PROCESSED_MESSAGES) {
        const firstItem = processedMessages.values().next().value;
        processedMessages.delete(firstItem);
    }

    return true;
}

// פונקציית ניקוי auth עם בעיות
function cleanupAuth() {
    try {
        if (fs.existsSync(AUTH_DIR)) {
            console.log("🧹 מנקה קבצי אישור פגומים...");
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            console.log("✅ קבצי אישור נוקו");
        }
    } catch (error) {
        console.error("❌ שגיאה בניקוי קבצי אישור:", error);
    }
}

// פונקציית התחברות משופרת עם טיפול בשגיאות MAC
async function connectToWhatsApp() {
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 5;

    async function connect() {
        try {
            console.log("🔄 מתחבר לוואטסאפ...");

            const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
            const { version } = await fetchLatestBaileysVersion();

            const sock = makeWASocket({
                version,
                auth: state,
                logger: pino({
                    level: "error", // הפחתת רמת הלוגים
                }),
                markOnlineOnConnect: false, // מניעת סימון אונליין אוטומטי
                generateHighQualityLinkPreview: false,
                syncFullHistory: false,
                printQRInTerminal: false,
                browser: Browsers.macOS("Desktop"),
                hedless: false, // הפעלת מצב ללא ראש
                connectTimeoutMs: 60000, // זמן קצוב מוגדל
                defaultQueryTimeoutMs: 30000,
                keepAliveIntervalMs: 30000,
                // הגדרות נוספות לטיפול בשגיאות
                retryRequestDelayMs: 250,
                maxMsgRetryCount: 3,
                // הגדרות לטיפול בשגיאות MAC
                shouldIgnoreJid: (jid) => isJidBroadcast(jid),
                getMessage: async (key) => {
                    // חזרת הודעה ריקה במקרה של בעיה
                    return { conversation: "" };
                },
            });

            sock.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    console.log("\n📱 QR Code להתחברות:");
                    qrcode.generate(qr, { small: true });
                }

                if (connection === "close") {
                    const statusCode =
                        lastDisconnect?.error?.output?.statusCode;
                    const shouldReconnect =
                        statusCode !== DisconnectReason.loggedOut;

                    console.log(`❌ חיבור נסגר. סטטוס: ${statusCode}`);

                    if (
                        statusCode === DisconnectReason.badSession ||
                        (lastDisconnect?.error?.message || "")
                            .toLowerCase()
                            .includes("bad mac")
                    ) {
                        console.log("🧹 זוהתה שגיאת MAC - מנקה session...");
                        cleanupAuth();
                        reconnectAttempts = 0; // איפוס מונה ניסיונות
                    }

                    if (
                        shouldReconnect &&
                        reconnectAttempts < MAX_RECONNECT_ATTEMPTS
                    ) {
                        reconnectAttempts++;
                        const delay = Math.min(5000 * reconnectAttempts, 30000); // עיכוב הדרגתי
                        console.log(
                            `🔄 ניסיון התחברות ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} בעוד ${delay / 1000} שניות...`,
                        );
                        setTimeout(connect, delay);
                    } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                        console.log(
                            "❌ מקסימום ניסיונות התחברות הושג. מנקה session ומתחיל מחדש...",
                        );
                        cleanupAuth();
                        reconnectAttempts = 0;
                        setTimeout(connect, 10000);
                    }
                } else if (connection === "open") {
                    console.log("🎉 הבוט מחובר בהצלחה!");
                    reconnectAttempts = 0; // איפוס מונה בהצלחה
                    connectionQuality.reconnectCount++;

                    // התחלת ניטור החיבור
                    startConnectionMonitoring(sock);
                }
            });

            sock.ev.on("creds.update", saveCreds);

            // טיפול בשגיאות חיבור
            sock.ev.on("connection.error", (error) => {
                console.error("❌ שגיאת חיבור:", error.message);
                if (
                    error.message.includes("Bad MAC") ||
                    error.message.includes("decrypt")
                ) {
                    console.log("🧹 שגיאת הצפנה - מנקה session...");
                    cleanupAuth();
                }
            });

            // טיפול בהודעות עם error handling משופר
            sock.ev.on("messages.upsert", async (m) => {
                try {
                    // כאן אתה צריך להשתמש ב-m, לא ב-msg
                    const message = m.messages[0];
                    if (!message.message) return;

                    await handleLinksInMessage(message, sock);

                    connectionQuality.messagesReceived++;

                    // בדיקות מהירות לפילטור הודעות לא רלוונטיות
                    if (
                        !message?.message ||
                        message.key?.fromMe ||
                        isJidBroadcast(message.key?.remoteJid) ||
                        !message.key?.id ||
                        !shouldProcessMessage(message.key.id)
                    ) {
                        return;
                    }

                    const messageText =
                        message.message.conversation ||
                        message.message.extendedTextMessage?.text ||
                        "";

                    if (!messageText.trim()) return;

                    const senderNumber = message.key.remoteJid?.replace(
                        "@s.whatsapp.net",
                        "",
                    );
                    if (!senderNumber) return;

                    const command = messageText
                        .trim()
                        .split(" ")[0]
                        .toLowerCase();

                    // עיבוד פקודות בצורה בטוחה
                    await processCommand(
                        sock,
                        message,
                        senderNumber,
                        messageText,
                        command,
                    );
                } catch (error) {
                    console.error("❌ שגיאה בעיבוד הודעה:", error.message);
                    connectionQuality.errors.push({
                        time: Date.now(),
                        error: error.message,
                        type: "message_processing",
                    });
                }
            });

            // טיפול בשגיאות כלליות
            sock.ev.on("CB:ib,,dirty", (node) => {
                console.log("📱 עדכון סטטוס dirty מהמכשיר");
            });

            sock.ev.on("CB:call", (node) => {
                console.log("📞 התקבלה הודעת שיחה");
            });

            return sock;
        } catch (error) {
            console.error("❌ שגיאה בהתחברות:", error.message);

            if (error.message.toLowerCase().includes("bad mac")) {
                console.log("🧹 מנקה session עקב שגיאת MAC...");
                cleanupAuth();
            }

            if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts++;
                const delay = Math.min(5000 * reconnectAttempts, 30000);
                console.log(`🔄 מנסה שוב בעוד ${delay / 1000} שניות...`);
                setTimeout(connect, delay);
            }
        }
    }

    await connect();
}

// עיבוד פקודות עם error handling משופר
async function processCommand(
    sock,
    message,
    senderNumber,
    messageText,
    command,
) {
    try {
        const args = messageText.trim().split(" ");
        const isOwnerUser = isOwner(senderNumber);
        const isAdminUser = isAdmin(senderNumber);

        // טיפול במצבי אינטראקציה תחילה
        const currentState = getState(senderNumber);
        if (currentState) {
            await handleInteractiveState(
                sock,
                message,
                senderNumber,
                messageText,
            );
            return;
        }

        // פקודות בעלים
        if (isOwnerUser) {
            if (command === "!הוסף" && args[1] === "מנהל" && args[2]) {
                const success = addAdmin(args[2]);
                await reply(
                    sock,
                    message,
                    success
                        ? `✅ המנהל ${args[2]} נוסף בהצלחה!`
                        : `❌ המנהל ${args[2]} כבר קיים או שגיאה.`,
                );
                return;
            }

            if (command === "!הסר" && args[1] === "מנהל" && args[2]) {
                const success = removeAdmin(args[2]);
                await reply(
                    sock,
                    message,
                    success
                        ? `✅ המנהל ${args[2]} הוסר בהצלחה!`
                        : `❌ המנהל ${args[2]} לא נמצא.`,
                );
                return;
            }

            if (command === "!ניקוי" && args[1] === "session") {
                cleanupAuth();
                await reply(
                    sock,
                    message,
                    "🧹 קבצי Session נוקו. הבוט יתחבר מחדש...",
                );
                process.exit(0);
                return;
            }
        }

        // פקודות מנהלים
        if (isAdminUser) {
            switch (command) {
                case "!מנהלים":
                    const adminList =
                        admins.length > 0
                            ? `📋 רשימת מנהלים:\n${admins.map((admin) => `• ${admin}`).join("\n")}`
                            : "📋 אין מנהלים רשומים.";
                    await reply(sock, message, adminList);
                    break;

                case "!הוסף":
                    if (args[1] === "פקודה") {
                        setState(senderNumber, {
                            action: "adding_command",
                            step: "waiting_for_command_name",
                        });
                        await reply(sock, message, "📝 שלח שם הפקודה החדשה:");
                    }
                    break;

                case "!הסר":
                    if (args[1] === "פקודה") {
                        const commandList = Object.keys(commands).sort();
                        if (commandList.length === 0) {
                            await reply(
                                sock,
                                message,
                                "❌ אין פקודות זמינות למחיקה.",
                            );
                        } else {
                            setState(senderNumber, {
                                action: "removing_command",
                                step: "waiting_for_command_name",
                            });
                            const replyText = `🗑️ בחר פקודה למחיקה:\n${commandList.map((cmd, i) => `${i + 1}. ${cmd}`).join("\n")}\n\nשלח את שם הפקודה או המספר:`;
                            await reply(sock, message, replyText);
                        }
                    }
                    break;

                case "!ערוך":
                    if (args[1] === "פקודה") {
                        const commandList = Object.keys(commands).sort();
                        if (commandList.length === 0) {
                            await reply(
                                sock,
                                message,
                                "❌ אין פקודות זמינות לעריכה.",
                            );
                        } else {
                            setState(senderNumber, {
                                action: "editing_command",
                                step: "waiting_for_command_name",
                            });
                            const replyText = `✏️ בחר פקודה לעריכה:\n${commandList.map((cmd, i) => `${i + 1}. ${cmd}`).join("\n")}\n\nשלח את שם הפקודה או המספר:`;
                            await reply(sock, message, replyText);
                        }
                    }
                    break;

                case "תרגם":
                    await handleSubtitlesTranslationCommand(sock, message);
                    break;
            }
        }

        // פקודות כלליות
        switch (command) {
            case "רשימה":
                const sender = message.key.participant || message.key.remoteJid;

                const isGroup = message.key.remoteJid.endsWith("@g.us");
                const isAdminOrOwner = ADMINS.includes(sender);

                if (!isGroup && !isAdminOrOwner) {
                    await sock.sendMessage(
                        message.key.remoteJid,
                        {
                            text: "❌ הפקודה הזו זמינה רק בקבוצות!\n👑 מנהלים ובעלים כן יכולים להשתמש בה בפרטי.",
                        },
                        { quoted: message },
                    );
                    return;
                }

                const commandList = Object.keys(commands).sort();
                const count = commandList.length;
                const replyText =
                    count > 0
                        ? `> *📋 רשימת סרטים/סדרות || ${count} 📋*

          *צחוק ויראלי בע''מ 📲 💥*
https://whatsapp.com/channel/0029VasYF5KHVvTjvTxtVR43
> *לפני הכל שלפו הצטרפות לערוץ* *🔯הראשי שלנו -->> פרגנו בעוקב🛐*
🔱ערוץ צחוק ויראלי בע''מ 📲💥🔱
מה שמופיע ברשימה שלי יהיה 
זמין לבקשות🙏

*יש לרשום בדיוק כפי שמופיע ברשימה, ללא הוספת מילים נוספות כמו ‘תשלח לי’, ‘אפשר’ וכדומה.*

${commandList.map((cmd) => `☜ • ${cmd}`).join("\n")}`
                        : "> 📋 אין פקודות זמינות.";
                await reply(sock, message, replyText);
                break;

            case "@כולם":
                await handleTagEveryone(sock, message);
                break;

            case "!עזרה":
                const helpText = `> *🤖 עזרה | בוטדרייב 🤖*

*פקודות כלליות:*
• !פקודות - רשימת פקודות זמינות
• !עזרה - הודעת עזרה זו
• !סטטוס - מידע על מצב הבוט
• / (שם הסרט) - מידע AI על סרט/סדרה


*פקודות למנהלים:*
• !הוסף פקודה - הוספת פקודה חדשה
• !הסר פקודה - הסרת פקודה קיימת
• !ערוך פקודה - עריכת פקודה קיימת
• !מנהלים - רשימת מנהלים
• !גיבוי - יצירת גיבוי ידני
• !גיבויים - רשימת גיבויים
• @כולם - תייגו את כולם בקבוצה
• תרגם (בתגובה על קובץ כתוביות) - תרגום AI לעברית!



*טיפים:*
• ניתן לבטל כל פעולה עם "ביטול"
• הבוט יוצר גיבוי אוטומטי כל שעה
• במקרה של בעיות - השתמש ב!ניקוי session`;
                await reply(sock, message, helpText);
                break;

            case "!סטטוס":
                const uptime = Math.floor((Date.now() - startTime) / 1000);
                const hours = Math.floor(uptime / 3600);
                const minutes = Math.floor((uptime % 3600) / 60);
                const seconds = uptime % 60;

                const recentErrors = connectionQuality.errors.filter(
                    (err) => Date.now() - err.time < 24 * 60 * 60 * 1000,
                ).length; // 24 שעות אחרונות

                const statusText = `> 📊 *סטטוס | בוטדרייב* 📊

• ⏰ זמן הפעלה: ${hours}ש ${minutes}ד ${seconds}ש
• 👥 מנהלים: ${admins.length}
• 📋 פקודות: ${Object.keys(commands).length}
• 💾 הודעות מעובדות: ${processedMessages.size}
• 👤 מצבי משתמשים: ${userStates.size}

📈 *סטטיסטיקות חיבור:*
• 📤 הודעות נשלחו: ${connectionQuality.messagesSent}
• 📥 הודעות התקבלו: ${connectionQuality.messagesReceived}
• 🔄 התחברויות: ${connectionQuality.reconnectCount}
• ⚠️ שגיאות (24ש): ${recentErrors}
• 📡 Ping אחרון: ${connectionQuality.lastPingTime}ms

💾 *גיבויים:*
• גיבוי אוטומטי כל שעה
• שמירה על 5 גיבויים אחרונים`;
                await reply(sock, message, statusText);
                break;

            case "!גיבוי":
                if (isAdminUser) {
                    const success = createBackup();
                    await reply(
                        sock,
                        message,
                        success
                            ? "✅ גיבוי נוצר בהצלחה!"
                            : "❌ שגיאה ביצירת גיבוי.",
                    );
                }
                break;

            case "!שחזור":
                if (isOwnerUser && args[1]) {
                    const success = restoreFromBackup(args[1]);
                    await reply(
                        sock,
                        message,
                        success
                            ? "✅ שחזור מגיבוי הושלם!"
                            : "❌ שגיאה בשחזור מגיבוי או קובץ לא נמצא.",
                    );
                }
                break;

            case "!גיבויים":
                if (isAdminUser) {
                    try {
                        const backupDir = "./backups";
                        if (!fs.existsSync(backupDir)) {
                            await reply(
                                sock,
                                message,
                                "❌ תיקיית גיבויים לא קיימת.",
                            );
                            break;
                        }

                        const backupFiles = fs
                            .readdirSync(backupDir)
                            .filter(
                                (file) =>
                                    file.startsWith("backup-") &&
                                    file.endsWith(".json"),
                            )
                            .sort()
                            .reverse()
                            .slice(0, 10); // 10 גיבויים אחרונים

                        if (backupFiles.length === 0) {
                            await reply(
                                sock,
                                message,
                                "❌ אין גיבויים זמינים.",
                            );
                        } else {
                            const backupList = `📋 *גיבויים זמינים:*\n\n${backupFiles
                                .map((file, i) => {
                                    const stat = fs.statSync(
                                        path.join(backupDir, file),
                                    );
                                    const date = new Date(
                                        stat.mtime,
                                    ).toLocaleString("he-IL");
                                    return `${i + 1}. ${file}\n   📅 ${date}`;
                                })
                                .join("\n\n")}`;
                            await reply(sock, message, backupList);
                        }
                    } catch (error) {
                        await reply(
                            sock,
                            message,
                            "❌ שגיאה בקריאת רשימת גיבויים.",
                        );
                    }
                }
                break;

            case "/":
                // פועל רק בקבוצות
                if (!message.key.remoteJid.endsWith("@g.us")) return;

                const movieName = args.slice(1).join(" ");

                if (!movieName) {
                    await sock.sendMessage(
                        message.key.remoteJid,
                        { text: "🎬 שלח שם סרט או סדרה!\nדוגמה: ./מידע אווטר" },
                        { quoted: message },
                    );
                    return;
                }

                // שולח את הודעת "מחפש..."
                const searchMsg = await sock.sendMessage(
                    message.key.remoteJid,
                    { text: "🔍 מחפש מידע על הסרט..." },
                    { quoted: message },
                );

                try {
                    const info = await getMovieInfo(movieName);

                    // עורך את ההודעה של "🔍 מחפש..." עם המידע
                    await sock.sendMessage(message.key.remoteJid, {
                        text: info,
                        edit: searchMsg.key,
                    });
                } catch (err) {
                    console.error("שגיאה ב־getMovieInfo:", err);

                    await sock.sendMessage(message.key.remoteJid, {
                        text: "❌ שגיאה בשליפת המידע. נסה שוב מאוחר יותר.",
                        edit: searchMsg.key,
                    });
                }

            default: {
                const isGroup = message.key.remoteJid.endsWith("@g.us");
                const sender = isGroup
                    ? message.key.participant
                    : message.key.remoteJid;
                const isAdminOrOwner = ADMINS.includes(sender);

                if (commands[command]) {
                    if (!isGroup && !isAdminOrOwner) {
                        await sock.sendMessage(
                            message.key.remoteJid,
                            {
                                text: "❌ הפקודה הזו זמינה רק בקבוצות!\n👑 רק מנהלים ובעלים יכולים להשתמש בה בפרטי.",
                            },
                            { quoted: message },
                        );
                        break;
                    }

                    // שלח את הפקודה המותאמת
                    await reply(sock, message, commands[command]);
                }
                break;
            }
        }
    } catch (error) {
        console.error("❌ שגיאה בעיבוד פקודה:", error.message);
        // לא שולחים הודעת שגיאה למשתמש כדי למנוע לולאות
    }
}

// טיפול במצבי אינטראקציה
async function handleInteractiveState(
    sock,
    message,
    senderNumber,
    messageText,
) {
    const state = getState(senderNumber);
    if (!state) return;

    const text = messageText.trim();

    // ביטול
    if (text.toLowerCase() === "ביטול" || text.toLowerCase() === "cancel") {
        clearState(senderNumber);
        await reply(sock, message, "❌ הפעולה בוטלה.");
        return;
    }

    try {
        switch (state.action) {
            case "adding_command":
                await handleAddCommand(
                    sock,
                    message,
                    senderNumber,
                    text,
                    state,
                );
                break;
            case "removing_command":
                await handleRemoveCommand(
                    sock,
                    message,
                    senderNumber,
                    text,
                    state,
                );
                break;
            case "editing_command":
                await handleEditCommand(
                    sock,
                    message,
                    senderNumber,
                    text,
                    state,
                );
                break;
        }
    } catch (error) {
        console.error("❌ שגיאה במצב אינטראקטיבי:", error.message);
        clearState(senderNumber);
        await reply(sock, message, "❌ אירעה שגיאה. הפעולה בוטלה.");
    }
}

// פונקציות עזר לטיפול במצבים (ללא שינוי)
async function handleAddCommand(sock, message, senderNumber, text, state) {
    if (state.step === "waiting_for_command_name") {
        if (commands[text]) {
            await reply(
                sock,
                message,
                `❌ הפקודה "${text}" כבר קיימת! בחר שם אחר:`,
            );
        } else {
            setState(senderNumber, {
                action: "adding_command",
                step: "waiting_for_response",
                commandName: text,
            });
            await reply(sock, message, `📝 שלח תגובה לפקודה "${text}":`);
        }
    } else if (state.step === "waiting_for_response") {
        const success = addCommand(state.commandName, text);
        await reply(
            sock,
            message,
            success
                ? `✅ הפקודה "${state.commandName}" נוספה בהצלחה!`
                : "❌ שגיאה בהוספת הפקודה.",
        );
        clearState(senderNumber);
    }
}

async function handleRemoveCommand(sock, message, senderNumber, text, state) {
    if (state.step === "waiting_for_command_name") {
        const commandList = Object.keys(commands).sort();
        let commandName;

        const index = parseInt(text) - 1;
        if (!isNaN(index) && index >= 0 && index < commandList.length) {
            commandName = commandList[index];
        } else if (commands[text]) {
            commandName = text;
        } else {
            await reply(sock, message, "❌ פקודה לא נמצאה!");
            return;
        }

        setState(senderNumber, {
            action: "removing_command",
            step: "waiting_for_confirmation",
            commandName: commandName,
        });

        await reply(
            sock,
            message,
            `⚠️ למחוק את הפקודה "${commandName}"?\nשלח "כן" לאישור או "לא" לביטול.`,
        );
    } else if (state.step === "waiting_for_confirmation") {
        const confirmation = text.toLowerCase();

        if (confirmation === "כן" || confirmation === "yes") {
            const success = removeCommand(state.commandName);
            await reply(
                sock,
                message,
                success
                    ? `✅ הפקודה "${state.commandName}" נמחקה!`
                    : `❌ שגיאה במחיקת הפקודה.`,
            );
        } else {
            await reply(sock, message, "❌ מחיקה בוטלה.");
        }
        clearState(senderNumber);
    }
}

async function handleEditCommand(sock, message, senderNumber, text, state) {
    if (state.step === "waiting_for_command_name") {
        const commandList = Object.keys(commands).sort();
        let commandName;

        const index = parseInt(text) - 1;
        if (!isNaN(index) && index >= 0 && index < commandList.length) {
            commandName = commandList[index];
        } else if (commands[text]) {
            commandName = text;
        } else {
            await reply(sock, message, "❌ פקודה לא נמצאה!");
            return;
        }

        setState(senderNumber, {
            action: "editing_command",
            step: "waiting_for_new_response",
            commandName: commandName,
        });

        await reply(
            sock,
            message,
            `✏️ עריכת "${commandName}"\n\nתגובה נוכחית:\n${commands[commandName]}\n\nשלח תגובה חדשה:`,
        );
    } else if (state.step === "waiting_for_new_response") {
        const success = editCommand(state.commandName, text);
        await reply(
            sock,
            message,
            success
                ? `✅ הפקודה "${state.commandName}" עודכנה!`
                : "❌ שגיאה בעדכון הפקודה.",
        );
        clearState(senderNumber);
    }
}

// רישום זמן התחלה לסטטיסטיקות
const startTime = Date.now();

// מערכת בקרת איכות החיבור
let connectionQuality = {
    lastPingTime: Date.now(),
    pingInterval: null,
    reconnectCount: 0,
    messagesSent: 0,
    messagesReceived: 0,
    errors: [],
};

// פונקציית ניטור החיבור
function startConnectionMonitoring(sock) {
    // בדיקת ping כל 30 שניות
    connectionQuality.pingInterval = setInterval(async () => {
        try {
            const start = Date.now();
            await sock.query({
                tag: "iq",
                attrs: { type: "get", xmlns: "w:p", id: Date.now().toString() },
                content: [{ tag: "ping" }],
            });
            const pingTime = Date.now() - start;
            connectionQuality.lastPingTime = pingTime;

            if (pingTime > 10000) {
                // אם ping גבוה מ-10 שניות
                console.warn(`⚠️ ping גבוה: ${pingTime}ms`);
            }
        } catch (error) {
            console.warn("⚠️ בעיה בבדיקת ping:", error.message);
            connectionQuality.errors.push({
                time: Date.now(),
                error: error.message,
            });
        }
    }, 30000);
}

function stopConnectionMonitoring() {
    if (connectionQuality.pingInterval) {
        clearInterval(connectionQuality.pingInterval);
        connectionQuality.pingInterval = null;
    }
}

// פונקציית backup אוטומטי
function createBackup() {
    try {
        const backupDir = "./backups";
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupFile = path.join(backupDir, `backup-${timestamp}.json`);

        const backupData = {
            admins,
            commands,
            timestamp: Date.now(),
            version: "2.0",
        };

        fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2));
        console.log(`💾 גיבוי נוצר: ${backupFile}`);

        // שמירה על 5 גיבויים אחרונים בלבד
        const backupFiles = fs
            .readdirSync(backupDir)
            .filter(
                (file) => file.startsWith("backup-") && file.endsWith(".json"),
            )
            .sort()
            .reverse();

        if (backupFiles.length > 5) {
            for (let i = 5; i < backupFiles.length; i++) {
                fs.unlinkSync(path.join(backupDir, backupFiles[i]));
            }
        }

        return true;
    } catch (error) {
        console.error("❌ שגיאה ביצירת גיבוי:", error);
        return false;
    }
}

// גיבוי אוטומטי כל שעה
setInterval(createBackup, 60 * 60 * 1000);

// פונקציית שחזור מגיבוי
function restoreFromBackup(backupFile) {
    try {
        const backupPath = path.join("./backups", backupFile);
        if (!fs.existsSync(backupPath)) {
            return false;
        }

        const backupData = JSON.parse(fs.readFileSync(backupPath, "utf8"));

        if (backupData.admins) {
            admins = backupData.admins;
            saveAdmins();
        }

        if (backupData.commands) {
            commands = backupData.commands;
            saveCommands();
        }

        console.log("✅ שחזור מגיבוי הושלם");
        return true;
    } catch (error) {
        console.error("❌ שגיאה בשחזור מגיבוי:", error);
        return false;
    }
}

// פונקציה לתיוג כל חברי הקבוצה
async function handleTagEveryone(sock, message) {
    try {
        const chatId = message.key.remoteJid;

        // בדיקה שזו קבוצה
        if (!chatId.endsWith("@g.us")) {
            return false; // לא קבוצה
        }

        // בדיקת הרשאות - מנהל קבוצה או בוט אדמין
        const senderNumber = message.key.participant || message.key.remoteJid;
        const cleanSender = senderNumber.replace("@s.whatsapp.net", "");

        // קבלת מידע על הקבוצה
        const groupMetadata = await sock.groupMetadata(chatId);

        // בדיקה אם השולח הוא מנהל קבוצה
        const senderIsGroupAdmin = groupMetadata.participants.find(
            (p) =>
                p.id === senderNumber &&
                (p.admin === "admin" || p.admin === "superadmin"),
        );

        // בדיקה אם השולח הוא מנהל בוט
        const senderIsBotAdmin = isAdmin(cleanSender);

        // רק מנהלי קבוצה או מנהלי בוט יכולים לתייג את כולם
        if (!senderIsGroupAdmin && !senderIsBotAdmin) {
            await reply(
                sock,
                message,
                "❌ רק מנהלי הקבוצה יכולים להשתמש בפקודה זו.",
            );
            return true;
        }

        // איסוף כל המשתתפים (ללא בוטים)
        const participants = groupMetadata.participants.map((p) => p.id);

        if (participants.length === 0) {
            await reply(sock, message, "❌ לא נמצאו חברים לתיוג.");
            return true;
        }

        // חלוקת המשתתפים לחלקים (מקסימום 5 לכל הודעה)
        const BATCH_SIZE = 5;
        const batches = [];

        for (let i = 0; i < participants.length; i += BATCH_SIZE) {
            batches.push(participants.slice(i, i + BATCH_SIZE));
        }

        // שליחת ההודעות
        const groupName = groupMetadata.subject || "הקבוצה";

        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            const isLastBatch = i === batches.length - 1;

            let messageText = `📢 *תיוג כללי - ${groupName}*\n`;
            messageText += `📍 חלק ${i + 1} מתוך ${batches.length}\n\n`;

            const mentionText = batch
                .map((id) => `@${id.split("@")[0]}`)
                .join(" ");
            messageText += mentionText;

            if (isLastBatch) {
                messageText += `\n\n👥 סה"כ ${participants.length} חברים`;
            }

            await sock.sendMessage(chatId, {
                text: messageText,
                mentions: batch,
            });

            // עיכוב קטן בין הודעות כדי למנוע spam
            if (i < batches.length - 1) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        }

        console.log(
            `📢 תויגו ${participants.length} חברים בקבוצה ${groupName}`,
        );
        return true;
    } catch (error) {
        console.error("❌ שגיאה בתיוג כולם:", error.message);
        await reply(sock, message, "❌ שגיאה בתיוג חברי הקבוצה.");
        return false;
    }
}

let ai;
(async () => {
    const { GoogleGenAI } = await import("@google/genai");
    ai = new GoogleGenAI({ apiKey: "AIzaSyAbrYGoag9xr8qb6fl4W8HsVoUoCDmZtig" });
})();
async function getMovieInfo(movieName) {
    if (!ai) throw new Error("AI not initialized yet");
    // בדיקת תיאור סרט/סדרה
    const check = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
            {
                role: "user",
                parts: [
                    {
                        text: `האם "${movieName}" הוא סרט או סדרה? ענה רק "כן" או "לא". וודא אבל לפני שזה נכון. לדוגמא, יש סדרה שקוראים לה - friends. וודא שאתה לא חוסם גם סרטים/סדרות כאלו!! אם יש ספק - ענה 'כן'.`,
                    },
                ],
            },
        ],
    });
    if (!check.text.includes("כן")) return "❌ רק סרטים/סדרות";
    // שאיבת מידע
    const info = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
            {
                role: "user",
                parts: [
                    {
                        text: `חפש מידע על "${movieName}" בפורמט:
🎬 ${movieName}
📅 שנה:
⭐ דירוג:
🎭 ז'אנר:
👥 שחקנים עיקריים:
🎬 במאי:
⏱️ משך:
📝 עלילה קצרה:`,
                    },
                ],
            },
        ],
        tools: [{ googleSearch: {} }],
    });
    return info.text;
}

const { GoogleGenerativeAI } = require("@google/generative-ai");

const GEMINI_API_KEY = "AIzaSyAbrYGoag9xr8qb6fl4W8HsVoUoCDmZtig";
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ✅ בניית קו התקדמות גרפי
function buildProgressBar(percent) {
    const totalBlocks = 12;
    const filled = Math.round((percent / 100) * totalBlocks);
    const empty = totalBlocks - filled;
    return `🔄 ${"▓".repeat(filled)}${"░".repeat(empty)} ${percent}%`;
}

// ✅ עדכון הודעה עם קו ואחוזים
async function updateProgress(sock, jid, msgKey, label, percent) {
    const text = `🛠️ ${label}\n${buildProgressBar(percent)}`;
    await sock.sendMessage(jid, { text, edit: msgKey });
}

// ✅ קו התקדמות מתמשך בזמן אמת
let liveProgress = 0;
let progressTimer;
function startLiveProgress(sock, jid, msgKey) {
    liveProgress = 15;
    progressTimer = setInterval(async () => {
        if (liveProgress >= 90) return;
        liveProgress += Math.floor(Math.random() * 6) + 1;
        if (liveProgress > 90) liveProgress = 90;
        await updateProgress(
            sock,
            jid,
            msgKey,
            "🔁 מתרגם כתוביות...",
            liveProgress,
        );
    }, 1500);
}
function stopLiveProgress() {
    if (progressTimer) clearInterval(progressTimer);
}

// ✅ זיהוי שפה אוטומטי
async function detectLanguage(text) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `מהי שפת הכתוביות הבאה? החזר רק את שם השפה:\n\n${text.slice(0, 1000)}`;
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
}

// ✅ תרגום כתוביות עם מגדר
async function translateSubtitlesWithGender(srtText) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `
תרגם את קובץ הכתוביות לעברית תוך שמירה על מגדר לפי שמות הדוברים. השתמש בלשון זכר/נקבה לפי הדמות. שמור על מבנה SRT.

בנוסף:
1. צור גרסה בפורמט VTT.
2. צור גרסה טקסטואלית של הדיאלוגים בלבד (TXT).

כתוביות:
${srtText}`;
    const result = await model.generateContent(prompt);
    return result.response.text();
}

// ✅ הפקודה הראשית: ./תרגם כתוביות
async function handleSubtitlesTranslationCommand(sock, message) {
    const quoted =
        message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const jid = message.key.remoteJid;

    if (!quoted || !quoted.documentMessage) {
        await sock.sendMessage(
            jid,
            {
                text: "📄 שלח קובץ `.srt` ותגיב אליו עם הפקודה: `./תרגם כתוביות`",
            },
            { quoted: message },
        );
        return;
    }

    // שליחת הודעת סטטוס התחלתית
    const progressMsg = await sock.sendMessage(
        jid,
        {
            text: `🛠️ מתרגם כתוביות...\n${buildProgressBar(0)}`,
        },
        { quoted: message },
    );

    // שלב 1 – הורדה
    await updateProgress(sock, jid, progressMsg.key, "⬇️ מוריד קובץ...", 10);
    const media = await downloadMediaMessage(
        { message: quoted },
        "buffer",
        {},
        { logger: console },
    );

    const tempFile = path.join(__dirname, "subs.srt");
    fs.writeFileSync(tempFile, media);

    // שלב 2 – קריאה + זיהוי שפה
    await updateProgress(sock, jid, progressMsg.key, "🧠 מזהה שפה...", 20);
    const srtText = fs.readFileSync(tempFile, "utf-8");
    const detectedLang = await detectLanguage(srtText);

    await updateProgress(
        sock,
        jid,
        progressMsg.key,
        `🌐 שפה מזוהה: ${detectedLang}`,
        25,
    );

    // התחלת התקדמות חיה
    startLiveProgress(sock, jid, progressMsg.key);

    // שלב 3 – תרגום
    const translated = await translateSubtitlesWithGender(srtText);

    // סיום עדכון חי
    stopLiveProgress();

    await updateProgress(sock, jid, progressMsg.key, "🔧 מעבד תוצאה...", 92);

    // פיצול תוצאה
    const srtOutput =
        translated
            .match(
                /(?:^|\n)(\d+\n\d{2}:\d{2}:\d{2},\d{3} --> .+?\n[\s\S]+?)(?=\n\d+\n|\n?$)/g,
            )
            ?.join("\n\n") || translated;
    const vttOutput = translated.includes("WEBVTT")
        ? translated.match(/WEBVTT[\s\S]+?(?=\n\n|\n$)/g)?.[0]
        : null;
    const textOutput =
        translated
            .match(/תרגום נקי:[\s\S]+?(?=\n\S|\n$)/g)?.[0]
            ?.replace(/^תרגום נקי:/, "") || null;

    const srtPath = path.join(__dirname, "כתוביות_מתורגמות.srt");
    const vttPath = path.join(__dirname, "כתוביות_מתורגמות.vtt");
    const txtPath = path.join(__dirname, "כתוביות_מתורגמות.txt");

    fs.writeFileSync(srtPath, srtOutput);
    if (vttOutput) fs.writeFileSync(vttPath, vttOutput);
    if (textOutput) fs.writeFileSync(txtPath, textOutput);

    // שליחת הקבצים
    await updateProgress(sock, jid, progressMsg.key, "📤 שולח קבצים...", 98);
    const replyOptions = { quoted: message };

    await sock.sendMessage(
        jid,
        {
            document: fs.readFileSync(srtPath),
            fileName: "כתוביות_מתורגמות.srt",
            mimetype: "application/x-subrip",
        },
        replyOptions,
    );

    if (vttOutput) {
        await sock.sendMessage(
            jid,
            {
                document: fs.readFileSync(vttPath),
                fileName: "כתוביות_מתורגמות.vtt",
                mimetype: "text/vtt",
            },
            replyOptions,
        );
    }

    if (textOutput) {
        await sock.sendMessage(
            jid,
            {
                document: fs.readFileSync(txtPath),
                fileName: "כתוביות_מתורגמות.txt",
                mimetype: "text/plain",
            },
            replyOptions,
        );
    }

    // סיום
    await updateProgress(
        sock,
        jid,
        progressMsg.key,
        "✅ תרגום הושלם בהצלחה!",
        100,
    );
}

async function handleLinksInMessage(message, sock) {
    const isGroup = message.key.remoteJid.endsWith("@g.us");
    if (!isGroup) return;

    const sender = message.key.participant || message.key.remoteJid;
    const isAdminOrOwner = ADMINS.includes(sender);

    const metadata = await sock.groupMetadata(message.key.remoteJid);
    const groupAdmins = metadata.participants
        .filter((p) => p.admin)
        .map((p) => p.id);

    const isGroupAdmin = groupAdmins.includes(sender);

    if (isAdminOrOwner || isGroupAdmin) return; // מותר להם הכל

    const text =
        message.message?.conversation ||
        message.message?.extendedTextMessage?.text ||
        "";
    const links = linkify.match(text);

    if (!links || links.length === 0) return;

    const nonDriveLinks = links.filter(
        (link) => !link.url.includes("drive.google.com"),
    );

    if (nonDriveLinks.length > 0) {
        // מחק את ההודעה
        await sock.sendMessage(message.key.remoteJid, {
            delete: {
                remoteJid: message.key.remoteJid,
                fromMe: false,
                id: message.key.id,
                participant: sender,
            },
        });

        // אזהרות
        warnings[sender] = (warnings[sender] || 0) + 1;
        fs.writeFileSync(WARNINGS_FILE, JSON.stringify(warnings, null, 2));

        if (warnings[sender] === 1) {
            await sock.sendMessage(
                message.key.remoteJid,
                {
                    text: `⚠️ @${sender.split("@")[0]}, שלחת קישור לא מאושר!\nרק Google Drive מותר פה.\nפעם הבאה – תוסר מהקבוצה.`,
                    mentions: [sender],
                },
                { quoted: message },
            );
        } else {
            // הסרה
            await sock.groupParticipantsUpdate(
                message.key.remoteJid,
                [sender],
                "remove",
            );

            // הודעה בקבוצה
            await sock.sendMessage(message.key.remoteJid, {
                text: `❌ @${sender.split("@")[0]} הוסר מהקבוצה לאחר ששלח שוב קישור לא מאושר.`,
                mentions: [sender],
            });

            // עדכון למנהלים
            for (let admin of ADMINS) {
                await sock.sendMessage(admin, {
                    text: `🚨 משתמש הוסר:\nשם קבוצה: ${metadata.subject}\nמספר: ${sender}\nסיבה: שלח קישור שאינו Google Drive פעמיים.`,
                });
            }

            // אפס את האזהרות שלו
            delete warnings[sender];
            fs.writeFileSync(WARNINGS_FILE, JSON.stringify(warnings, null, 2));
        }
    }
}

// הפעלת הבוט
console.log("🚀 מפעיל בוט WhatsApp מתקדם...");
console.log("📋 תכונות חדשות:");
console.log("   • 🛡️ טיפול בשגיאות Bad MAC");
console.log("   • 🧹 ניקוי אוטומטי של session פגום");
console.log("   • 🔄 התחברות הדרגתית חכמה");
console.log("   • 📊 מעקב איכות החיבור");
console.log("   • 💾 גיבוי אוטומטי כל שעה");
console.log("   • 🔧 פקודות ניהול מתקדמות");
console.log("   • 📈 סטטיסטיקות מפורטות");
console.log("────────────────────────────────");

// יצירת גיבוי ראשוני
createBackup();

connectToWhatsApp();

// טיפול באותות סיום עם ניקוי נכון
process.on("SIGINT", () => {
    console.log("\n⏹️ מפסיק בוט...");
    stopConnectionMonitoring();
    createBackup(); // גיבוי אחרון לפני סגירה
    setTimeout(() => process.exit(0), 1000);
});

process.on("SIGTERM", () => {
    console.log("\n⏹️ מפסיק בוט...");
    stopConnectionMonitoring();
    createBackup(); // גיבוי אחרון לפני סגירה
    setTimeout(() => process.exit(0), 1000);
});

// טיפול בשגיאות לא נתפסות
process.on("unhandledRejection", (reason, promise) => {
    console.error("❌ Unhandled Rejection:", reason);
});

process.on("uncaughtException", (error) => {
    console.error("❌ Uncaught Exception:", error);
    // לא יוצאים מהתהליך אלא אם כן זה קריטי
});
