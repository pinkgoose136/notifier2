require("dotenv").config();
const fs = require("fs");

// ======================================================
// CONFIG
// ======================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const USER_ID = String(process.env.TELEGRAM_USER_ID || "");
const CHECK_INTERVAL = Number(process.env.CHECK_INTERVAL || 60) * 1000;
const MULTIPLIER = 0.65;

const BINANCE_API = process.env.BINANCE_API || "https://data-api.binance.vision";
const STATE_FILE = process.env.STATE_FILE || "./range-state.json";

// ======================================================
// COINS
// ======================================================

function normalizeCoin(coin) {
    if (!coin) return "";

    let value = String(coin).trim().toUpperCase().replace(/\s+/g, "");

    if (value.endsWith("USDT")) {
        value = value.slice(0, -4);
    }

    return value;
}

function getSymbol(coin) {
    return `${normalizeCoin(coin)}USDT`;
}

// ======================================================
// STATE
// ======================================================

function defaultState() {
    const coins = (process.env.SYMBOLS || "BTC,ETH,SOL")
        .split(",")
        .map(normalizeCoin)
        .filter(Boolean);

    return {
        coins,
        touchState: {}
    };
}

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) {
            return defaultState();
        }

        const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));

        return {
            coins: Array.isArray(saved.coins) && saved.coins.length
                ? saved.coins.map(normalizeCoin).filter(Boolean)
                : defaultState().coins,

            touchState: saved.touchState || {}
        };
    } catch (err) {
        console.error("Ошибка state:", err.message);
        return defaultState();
    }
}

let state = loadState();

function saveState() {
    const temporaryFile = `${STATE_FILE}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(state, null, 2));
    fs.renameSync(temporaryFile, STATE_FILE);
}

function getCoins() {
    return state.coins;
}

// ======================================================
// DATE
// ======================================================

// Дневные свечи Binance и сброс лимитов — по UTC.
function getUtcDateKey() {
    return new Date().toISOString().slice(0, 10);
}

// ======================================================
// TELEGRAM
// ======================================================

async function telegramRequest(method, data = {}) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(data)
    });

    const result = await response.json();

    if (!response.ok || !result.ok) {
        throw new Error(`Telegram: ${JSON.stringify(result)}`);
    }

    return result.result;
}

async function sendTelegram(text) {
    return telegramRequest("sendMessage", {
        chat_id: USER_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
    });
}

// ======================================================
// BINANCE
// ======================================================

async function binanceRequest(path) {
    const response = await fetch(`${BINANCE_API}${path}`);

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Binance ${response.status}: ${text}`);
    }

    return response.json();
}

async function getCurrentPrice(coin) {
    const symbol = getSymbol(coin);
    const data = await binanceRequest(`/api/v3/ticker/price?symbol=${symbol}`);
    const price = Number(data.price);

    if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`${coin}: некорректная цена`);
    }

    return price;
}

// ======================================================
// PREVIOUS CLOSED DAY
// ======================================================

async function getPreviousDayCandle(coin) {
    const symbol = getSymbol(coin);

    const rows = await binanceRequest(
        `/api/v3/klines?symbol=${symbol}&interval=1d&limit=5`
    );

    if (!Array.isArray(rows) || rows.length < 2) {
        throw new Error(`${coin}: недостаточно дневных свечей`);
    }

    const now = Date.now();
    const closed = rows.filter(row => Number(row[6]) < now);

    if (!closed.length) {
        throw new Error(`${coin}: нет закрытой дневной свечи`);
    }

    const row = closed[closed.length - 1];

    return {
        openTime: Number(row[0]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        closeTime: Number(row[6])
    };
}

// ======================================================
// LEVEL CALCULATION
// ======================================================

function calculateLevelPair(previousHigh, previousLow, multiplier) {
    const priceRange = previousHigh - previousLow;
    const middle = (previousHigh + previousLow) / 2;

    return {
        resistance: middle + priceRange * multiplier,
        support: middle - priceRange * multiplier
    };
}

function calculateAllLevels(candle) {
    return calculateLevelPair(candle.high, candle.low, MULTIPLIER);
}

async function getMarketData(coin) {
    const [price, previousDay] = await Promise.all([
        getCurrentPrice(coin),
        getPreviousDayCandle(coin)
    ]);

    return {
        coin,
        price,
        previousDay,
        levels: calculateAllLevels(previousDay)
    };
}

// ======================================================
// CONDITIONS
// ======================================================

// Никакой толерантности.
// Поддержка: цена коснулась уровня или находится ниже.
// Сопротивление: цена коснулась уровня или находится выше.
function isLevelReached(price, level) {
    return level.side === "support"
        ? price <= level.price
        : price >= level.price;
}

// Расстояние используется только в отчётах.
function getDistancePercent(price, level) {
    return Math.abs(price - level) / price * 100;
}

// ======================================================
// FORMATTING
// ======================================================

function formatPrice(price) {
    if (!Number.isFinite(price)) return "?";
    if (price >= 1000) return price.toFixed(2);
    if (price >= 100) return price.toFixed(3);
    if (price >= 10) return price.toFixed(4);
    if (price >= 1) return price.toFixed(5);
    if (price >= 0.1) return price.toFixed(6);
    if (price >= 0.01) return price.toFixed(7);

    return price.toFixed(8);
}

function formatDistance(value) {
    if (value < 0.001) return "<0.001%";
    return `${value.toFixed(3)}%`;
}

// ======================================================
// LEVEL INFO
// ======================================================

function getLevelObjects(levels) {
    return [
        {
            key: "resistance",
            multiplier: "0.65",
            side: "resistance",
            short: "R0.65",
            title: "Resistance 0.65",
            emoji: "🔴",
            price: levels.resistance
        },
        {
            key: "support",
            multiplier: "0.65",
            side: "support",
            short: "S0.65",
            title: "Support 0.65",
            emoji: "🟢",
            price: levels.support
        }
    ];
}

function getNearestLevel(price, levels) {
    const items = getLevelObjects(levels)
        .map(level => ({
            ...level,
            distance: getDistancePercent(price, level.price)
        }))
        .sort((a, b) => a.distance - b.distance);

    return items[0];
}

// ======================================================
// DAILY LIMITS
// ======================================================

/*
    Для каждой монеты отдельные независимые отметки:

    BTC: {
        date: "2026-10-27",
        version: "0.65-daily",
        support: true,
        resistance: false
    }

    Поддержка BTC сработала — повторно сегодня не отправляем.
    Сопротивление BTC при этом ещё может сработать.

    Сигнал сопротивления НЕ разрешает поддержку повторно.

    ETH, SOL и остальные монеты имеют собственные отметки.
*/

function prepareCoinState(coin, date = getUtcDateKey()) {
    const saved = state.touchState[coin];

    if (!saved || saved.date !== date || saved.version !== "0.65-daily") {
        state.touchState[coin] = {
            date,
            version: "0.65-daily",
            support: false,
            resistance: false
        };
    }

    return state.touchState[coin];
}

function canNotifyLevel(coin, level, date) {
    return prepareCoinState(coin, date)[level.side] !== true;
}

function markLevelTriggered(coin, level, date) {
    prepareCoinState(coin, date)[level.side] = true;
    saveState();
}

// ======================================================
// ALERTS
// ======================================================

async function sendLevelAlert(coin, price, level) {
    const direction = level.side === "support"
        ? "поддержки"
        : "сопротивления";

    await sendTelegram(
        `${level.emoji} <b>${coin}</b>\n\n` +
        `<b>Касание / выход за уровень ${direction} 0.65</b>\n\n` +
        `Цена: <b>${formatPrice(price)}</b>\n` +
        `Уровень: <b>${formatPrice(level.price)}</b>`
    );
}

async function checkSymbol(coin) {
    const date = getUtcDateKey();
    const data = await getMarketData(coin);

    // Если во время запросов сменился день, ждём следующую проверку.
    if (getUtcDateKey() !== date) return;

    for (const level of getLevelObjects(data.levels)) {
        if (!isLevelReached(data.price, level)) continue;
        if (!canNotifyLevel(coin, level, date)) continue;

        await sendLevelAlert(coin, data.price, level);

        // Отмечаем после успешной отправки.
        // При ошибке Telegram лимит не расходуется.
        markLevelTriggered(coin, level, date);
    }
}

// ======================================================
// CHECK ALL
// ======================================================

let checking = false;

async function checkAll() {
    if (checking) return;

    checking = true;

    try {
        for (const coin of getCoins()) {
            try {
                await checkSymbol(coin);
            } catch (err) {
                console.error(`${coin}:`, err.message);
            }
        }
    } finally {
        checking = false;
    }
}

// ======================================================
// /CHECK
// ======================================================

async function createCheckReport() {
    const lines = [
        "<b>📊 Ближайшие уровни</b>",
        "",
        "Множитель: <b>0.65</b>",
        ""
    ];

    for (const coin of getCoins()) {
        try {
            const data = await getMarketData(coin);
            const nearest = getNearestLevel(data.price, data.levels);

            lines.push(
                `${nearest.emoji} <b>${coin}</b>: ` +
                `${nearest.short} — ` +
                `<b>${formatDistance(nearest.distance)}</b>`
            );
        } catch (err) {
            console.error(`${coin}:`, err.message);
            lines.push(`❌ <b>${coin}</b>: ошибка`);
        }
    }

    return lines.join("\n");
}

async function sendCheckReport() {
    await sendTelegram(await createCheckReport());
}

// ======================================================
// /LEVELS
// ======================================================

function createLevelsVisual(data) {
    const items = [
        ...getLevelObjects(data.levels).map(level => ({
            type: "level",
            value: level.price,
            level
        })),
        {
            type: "price",
            value: data.price
        }
    ].sort((a, b) => b.value - a.value);

    const lines = [];

    for (let i = 0; i < items.length; i++) {
        const item = items[i];

        if (item.type === "price") {
            lines.push(
                `🪙 <b>${data.coin}</b> ` +
                `<b>${formatPrice(data.price)}</b>`
            );
        } else {
            const level = item.level;
            const distance = getDistancePercent(data.price, level.price);

            lines.push(
                `${level.emoji} <b>${level.title}</b>\n` +
                `${formatPrice(level.price)} ` +
                `(${formatDistance(distance)})`
            );
        }

        if (i === items.length - 1) continue;

        const next = items[i + 1];
        let blankLines = 2;

        if (
            item.type === "level" &&
            next.type === "level" &&
            item.level.key === "resistance" &&
            next.level.key === "support"
        ) {
            blankLines = 4;
        }

        lines.push("\n".repeat(blankLines));
    }

    return lines.join("\n");
}

async function sendLevelsReport(coin) {
    const normalized = normalizeCoin(coin);

    if (!normalized) {
        await sendTelegram("Использование:\n<code>/levels BTC</code>");
        return;
    }

    if (!await coinExists(normalized)) {
        await sendTelegram(
            `❌ Пара <b>${normalized}USDT</b> не найдена.`
        );
        return;
    }

    const data = await getMarketData(normalized);

    await sendTelegram(
        `<b>📐 ${normalized} — уровни на сегодня</b>\n\n` +
        `Предыдущий день:\n` +
        `High: ${formatPrice(data.previousDay.high)}\n` +
        `Low: ${formatPrice(data.previousDay.low)}\n\n\n` +
        createLevelsVisual(data)
    );
}

// ======================================================
// COIN VALIDATION
// ======================================================

async function coinExists(coin) {
    const symbol = getSymbol(coin);

    try {
        const response = await fetch(
            `${BINANCE_API}/api/v3/exchangeInfo?symbol=${symbol}`
        );

        if (!response.ok) return false;

        const data = await response.json();

        return Array.isArray(data.symbols) && data.symbols.length > 0;
    } catch {
        return false;
    }
}

// ======================================================
// TELEGRAM COMMANDS
// ======================================================

let waitingForCoins = false;
let updateOffset = 0;

function commandMatches(text, command) {
    return text === command || text.startsWith(`${command}@`);
}

async function processTelegramMessage(message) {
    if (!message) return;

    const chatId = String(message.chat?.id || "");
    const userId = String(message.from?.id || "");

    if (chatId !== USER_ID || userId !== USER_ID) return;

    const text = String(message.text || "").trim();

    if (!text) return;

    // /START
    if (commandMatches(text, "/start")) {
        waitingForCoins = false;

        await sendTelegram(
            `<b>1D Range Monitor</b>\n\n` +
            `Множитель: <b>0.65</b>\n` +
            `Касание или выход за уровень, без допуска.\n` +
            `Проверка: каждые ${CHECK_INTERVAL / 1000} сек.\n` +
            `На монету: одна поддержка и одно сопротивление за UTC-день.\n\n` +
            `/check — ближайшие уровни\n` +
            `/levels BTC — уровни монеты\n` +
            `/coins — изменить монеты`
        );

        return;
    }

    // /CHECK
    if (commandMatches(text, "/check")) {
        waitingForCoins = false;
        await sendCheckReport();
        return;
    }

    // /LEVELS
    if (text.startsWith("/levels")) {
        waitingForCoins = false;

        const parts = text.split(/\s+/);
        await sendLevelsReport(parts[1] || "");

        return;
    }

    // /COINS
    if (commandMatches(text, "/coins")) {
        waitingForCoins = true;

        await sendTelegram(
            `<b>Сейчас отслеживаются:</b>\n\n` +
            `${getCoins().join(", ")}\n\n` +
            `Пришли новый список через запятую.\n\n` +
            `Например:\n` +
            `<code>BTC, ETH, SOL, XRP, ONDO</code>\n\n` +
            `USDT писать не нужно.`
        );

        return;
    }

    // NEW COIN LIST
    if (waitingForCoins) {
        const coins = [
            ...new Set(
                text.split(",").map(normalizeCoin).filter(Boolean)
            )
        ];

        if (!coins.length) {
            await sendTelegram("❌ Не удалось распознать список.");
            return;
        }

        const valid = [];
        const invalid = [];

        for (const coin of coins) {
            if (await coinExists(coin)) {
                valid.push(coin);
            } else {
                invalid.push(coin);
            }
        }

        if (!valid.length) {
            await sendTelegram("❌ Ни одной USDT-пары не найдено.");
            return;
        }

        state.coins = valid;

        // Дневные отметки сохраняются даже при удалении монеты.
        // Если добавить её обратно сегодня, повторного сигнала не будет.
        saveState();

        waitingForCoins = false;

        let answer =
            `✅ <b>Список обновлён</b>\n\n` +
            `${valid.join(", ")}`;

        if (invalid.length) {
            answer += `\n\n⚠️ Не найдены:\n${invalid.join(", ")}`;
        }

        await sendTelegram(answer);
    }
}

// ======================================================
// TELEGRAM POLLING
// ======================================================

async function telegramPolling() {
    while (true) {
        try {
            const updates = await telegramRequest("getUpdates", {
                offset: updateOffset,
                timeout: 30,
                allowed_updates: ["message"]
            });

            for (const update of updates) {
                updateOffset = update.update_id + 1;
                await processTelegramMessage(update.message);
            }
        } catch (err) {
            console.error("Telegram polling:", err.message);

            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
}

// ======================================================
// STARTUP REPORT
// ======================================================

async function sendStartupReport() {
    await sendTelegram(
        [
            "<b>🚀 1D Range Monitor запущен</b>",
            "",
            "Множитель: <b>0.65</b>",
            "Лимит: по одному сигналу на каждую сторону монеты за UTC-день.",
            `Проверка: <b>${CHECK_INTERVAL / 1000} сек.</b>`,
            "",
            "Монеты:",
            `<b>${getCoins().join(", ")}</b>`
        ].join("\n")
    );
}

// ======================================================
// MAIN
// ======================================================

async function main() {
    if (!BOT_TOKEN) {
        throw new Error("Нет TELEGRAM_BOT_TOKEN");
    }

    if (!USER_ID) {
        throw new Error("Нет TELEGRAM_USER_ID");
    }

    console.log("1D Range Monitor");
    console.log("Монеты:", getCoins().join(", "));
    console.log("Multiplier:", MULTIPLIER);
    console.log("Check interval:", `${CHECK_INTERVAL / 1000}s`);

    await sendStartupReport();

    // Проверяем сразу при запуске, затем по CHECK_INTERVAL.
    // При запуске на уровне или за ним сигнал тоже разрешён,
    // если эта сторона монеты ещё не уведомляла сегодня.
    await checkAll();

    setInterval(checkAll, CHECK_INTERVAL);

    telegramPolling();
}

main().catch(async err => {
    console.error(err);

    try {
        await sendTelegram(
            `❌ <b>Ошибка 1D Range Monitor</b>\n\n` +
            `${String(err.message || err)}`
        );
    } catch {}
});
