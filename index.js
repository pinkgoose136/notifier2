require("dotenv").config();
const fs = require("fs");

// ======================================================
// CONFIG
// ======================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const USER_ID = String(process.env.TELEGRAM_USER_ID || "");

const CHECK_INTERVAL =
    Number(process.env.CHECK_INTERVAL || 60) * 1000;

// 0.1 = 0.1%
const TOUCH_THRESHOLD_PERCENT =
    Number(process.env.TOUCH_THRESHOLD_PERCENT || 0.1);

const MULTIPLIER_05 = 0.5;
const MULTIPLIER_10 = 1.0;

const BINANCE_API =
    process.env.BINANCE_API ||
    "https://data-api.binance.vision";

// Отдельный state, чтобы не конфликтовать с PSO-ботом
const STATE_FILE =
    process.env.STATE_FILE ||
    "./range-state.json";


// ======================================================
// COINS
// ======================================================

function normalizeCoin(coin) {
    if (!coin) return "";

    let value = String(coin)
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "");

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
    const coins = (
        process.env.SYMBOLS ||
        "BTC,ETH,SOL"
    )
        .split(",")
        .map(normalizeCoin)
        .filter(Boolean);

    return {
        coins,

        /*
            Состояние касаний:

            touchState: {
                BTC: {
                    date: "2026-10-01",

                    "0.5": "support",
                    "1": null
                }
            }

            Если последним был support 0.5:
            support 0.5 больше не уведомляет,
            resistance 0.5 уведомляет и меняет side.

            После этого support снова разрешён.
        */
        touchState: {}
    };
}

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) {
            return defaultState();
        }

        const saved = JSON.parse(
            fs.readFileSync(
                STATE_FILE,
                "utf8"
            )
        );

        return {
            coins:
                Array.isArray(saved.coins) &&
                saved.coins.length
                    ? saved.coins
                        .map(normalizeCoin)
                        .filter(Boolean)
                    : defaultState().coins,

            touchState:
                saved.touchState || {}
        };

    } catch (err) {
        console.error(
            "Ошибка state:",
            err.message
        );

        return defaultState();
    }
}

let state = loadState();

function saveState() {
    fs.writeFileSync(
        STATE_FILE,
        JSON.stringify(
            state,
            null,
            2
        )
    );
}

function getCoins() {
    return state.coins;
}


// ======================================================
// DATE
// ======================================================

// Binance crypto daily candles работают относительно UTC.
// Нам нужен идентификатор текущего UTC-дня.

function getUtcDateKey() {
    return new Date()
        .toISOString()
        .slice(0, 10);
}


// ======================================================
// TELEGRAM
// ======================================================

async function telegramRequest(
    method,
    data = {}
) {
    const url =
        `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

    const response =
        await fetch(url, {
            method: "POST",

            headers: {
                "Content-Type":
                    "application/json"
            },

            body:
                JSON.stringify(data)
        });

    const result =
        await response.json();

    if (
        !response.ok ||
        !result.ok
    ) {
        throw new Error(
            `Telegram: ${
                JSON.stringify(result)
            }`
        );
    }

    return result.result;
}

async function sendTelegram(text) {
    return telegramRequest(
        "sendMessage",
        {
            chat_id:
                USER_ID,

            text,

            parse_mode:
                "HTML",

            disable_web_page_preview:
                true
        }
    );
}


// ======================================================
// BINANCE REQUEST
// ======================================================

async function binanceRequest(path) {
    const response =
        await fetch(
            `${BINANCE_API}${path}`
        );

    if (!response.ok) {
        const text =
            await response.text();

        throw new Error(
            `Binance ${response.status}: ${text}`
        );
    }

    return response.json();
}


// ======================================================
// CURRENT PRICE
// ======================================================

async function getCurrentPrice(coin) {
    const symbol =
        getSymbol(coin);

    const data =
        await binanceRequest(
            `/api/v3/ticker/price?symbol=${symbol}`
        );

    const price =
        Number(data.price);

    if (
        !Number.isFinite(price) ||
        price <= 0
    ) {
        throw new Error(
            `${coin}: некорректная цена`
        );
    }

    return price;
}


// ======================================================
// PREVIOUS CLOSED DAY
// ======================================================

async function getPreviousDayCandle(coin) {
    const symbol =
        getSymbol(coin);

    const rows =
        await binanceRequest(
            `/api/v3/klines` +
            `?symbol=${symbol}` +
            `&interval=1d` +
            `&limit=5`
        );

    if (
        !Array.isArray(rows) ||
        rows.length < 2
    ) {
        throw new Error(
            `${coin}: недостаточно дневных свечей`
        );
    }

    const now =
        Date.now();

    // Берём последнюю ПОЛНОСТЬЮ закрытую
    // дневную свечу.

    const closed =
        rows.filter(
            row =>
                Number(row[6]) < now
        );

    if (!closed.length) {
        throw new Error(
            `${coin}: нет закрытой дневной свечи`
        );
    }

    const row =
        closed[
            closed.length - 1
        ];

    return {
        openTime:
            Number(row[0]),

        high:
            Number(row[2]),

        low:
            Number(row[3]),

        close:
            Number(row[4]),

        closeTime:
            Number(row[6])
    };
}


// ======================================================
// LEVEL CALCULATION
// ======================================================

function calculateLevelPair(
    previousHigh,
    previousLow,
    multiplier
) {
    const priceRange =
        previousHigh -
        previousLow;

    const middle =
        (
            previousHigh +
            previousLow
        ) / 2;

    const resistance =
        middle +
        priceRange *
        multiplier;

    const support =
        middle -
        priceRange *
        multiplier;

    return {
        resistance,
        support
    };
}

function calculateAllLevels(candle) {
    const level05 =
        calculateLevelPair(
            candle.high,
            candle.low,
            MULTIPLIER_05
        );

    const level10 =
        calculateLevelPair(
            candle.high,
            candle.low,
            MULTIPLIER_10
        );

    return {
        resistance10:
            level10.resistance,

        resistance05:
            level05.resistance,

        support05:
            level05.support,

        support10:
            level10.support
    };
}


// ======================================================
// MARKET DATA
// ======================================================

async function getMarketData(coin) {
    const [
        price,
        previousDay
    ] =
        await Promise.all([
            getCurrentPrice(coin),
            getPreviousDayCandle(coin)
        ]);

    const levels =
        calculateAllLevels(
            previousDay
        );

    return {
        coin,
        price,
        previousDay,
        levels
    };
}


// ======================================================
// DISTANCE
// ======================================================

function getDistancePercent(
    price,
    level
) {
    return (
        Math.abs(
            price - level
        ) /
        price *
        100
    );
}

function isTouching(
    price,
    level
) {
    return (
        getDistancePercent(
            price,
            level
        ) <=
        TOUCH_THRESHOLD_PERCENT
    );
}


// ======================================================
// FORMAT PRICE
// ======================================================

function formatPrice(price) {
    if (!Number.isFinite(price)) {
        return "?";
    }

    if (price >= 10000) {
        return price.toFixed(2);
    }

    if (price >= 1000) {
        return price.toFixed(2);
    }

    if (price >= 100) {
        return price.toFixed(3);
    }

    if (price >= 10) {
        return price.toFixed(4);
    }

    if (price >= 1) {
        return price.toFixed(5);
    }

    if (price >= 0.1) {
        return price.toFixed(6);
    }

    if (price >= 0.01) {
        return price.toFixed(7);
    }

    return price.toFixed(8);
}

function formatDistance(value) {
    if (value < 0.001) {
        return "<0.001%";
    }

    return `${value.toFixed(3)}%`;
}


// ======================================================
// LEVEL INFO
// ======================================================

function getLevelObjects(levels) {
    return [
        {
            key: "resistance10",
            multiplier: "1",
            side: "resistance",
            short: "R1.0",
            title: "Resistance 1.0",
            emoji: "🔴",
            price: levels.resistance10
        },

        {
            key: "resistance05",
            multiplier: "0.5",
            side: "resistance",
            short: "R0.5",
            title: "Resistance 0.5",
            emoji: "🔴",
            price: levels.resistance05
        },

        {
            key: "support05",
            multiplier: "0.5",
            side: "support",
            short: "S0.5",
            title: "Support 0.5",
            emoji: "🟢",
            price: levels.support05
        },

        {
            key: "support10",
            multiplier: "1",
            side: "support",
            short: "S1.0",
            title: "Support 1.0",
            emoji: "🟢",
            price: levels.support10
        }
    ];
}

function getNearestLevel(
    price,
    levels
) {
    const items =
        getLevelObjects(levels)
            .map(level => ({
                ...level,

                distance:
                    getDistancePercent(
                        price,
                        level.price
                    )
            }))
            .sort(
                (a, b) =>
                    a.distance -
                    b.distance
            );

    return items[0];
}


// ======================================================
// TOUCH STATE
// ======================================================

function prepareCoinState(coin) {
    const date =
        getUtcDateKey();

    if (
        !state.touchState[coin] ||
        state.touchState[coin].date !== date
    ) {
        state.touchState[coin] = {
            date,

            "0.5":
                null,

            "1":
                null
        };

        saveState();
    }

    return state.touchState[coin];
}

function canNotifyLevel(
    coin,
    level
) {
    const coinState =
        prepareCoinState(coin);

    const previousSide =
        coinState[
            level.multiplier
        ];

    /*
        Если предыдущим сигналом этой пары
        была та же сторона — молчим.

        support 0.5 -> support 0.5 = NO

        support 0.5 -> resistance 0.5 = YES

        resistance 0.5 -> support 0.5 = YES
    */

    return (
        previousSide !==
        level.side
    );
}

function markLevelTriggered(
    coin,
    level
) {
    const coinState =
        prepareCoinState(coin);

    coinState[
        level.multiplier
    ] =
        level.side;

    saveState();
}


// ======================================================
// ALERT
// ======================================================

async function sendLevelAlert(
    coin,
    price,
    level
) {
    const distance =
        getDistancePercent(
            price,
            level.price
        );

    const direction =
        level.side === "support"
            ? "поддержки"
            : "сопротивления";

    await sendTelegram(
        `${level.emoji} <b>${coin}</b>\n\n` +

        `<b>Касание ${direction} ${level.multiplier}</b>\n\n` +

        `Цена: <b>${formatPrice(price)}</b>\n` +

        `Уровень: <b>${formatPrice(level.price)}</b>\n` +

        `Расстояние: <b>${formatDistance(distance)}</b>\n\n` +

        `Порог: ${TOUCH_THRESHOLD_PERCENT}%`
    );
}


// ======================================================
// CHECK SYMBOL
// ======================================================

async function checkSymbol(coin) {
    const data =
        await getMarketData(
            coin
        );

    const levels =
        getLevelObjects(
            data.levels
        );

    /*
        Может теоретически оказаться сразу
        внутри допуска нескольких уровней.

        Проверяем ближайший первым.
    */

    const touched =
        levels
            .map(level => ({
                ...level,

                distance:
                    getDistancePercent(
                        data.price,
                        level.price
                    )
            }))
            .filter(
                level =>
                    level.distance <=
                    TOUCH_THRESHOLD_PERCENT
            )
            .sort(
                (a, b) =>
                    a.distance -
                    b.distance
            );

    for (
        const level
        of touched
    ) {
        if (
            !canNotifyLevel(
                coin,
                level
            )
        ) {
            continue;
        }

        markLevelTriggered(
            coin,
            level
        );

        await sendLevelAlert(
            coin,
            data.price,
            level
        );
    }
}


// ======================================================
// CHECK ALL
// ======================================================

let checking = false;

async function checkAll() {
    if (checking) {
        return;
    }

    checking = true;

    try {
        for (
            const coin
            of getCoins()
        ) {
            try {
                await checkSymbol(
                    coin
                );

            } catch (err) {
                console.error(
                    `${coin}:`,
                    err.message
                );
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
        `<b>📊 Ближайшие уровни</b>`,
        "",
        `Порог касания: <b>${TOUCH_THRESHOLD_PERCENT}%</b>`,
        ""
    ];

    for (
        const coin
        of getCoins()
    ) {
        try {
            const data =
                await getMarketData(
                    coin
                );

            const nearest =
                getNearestLevel(
                    data.price,
                    data.levels
                );

            lines.push(
                `${nearest.emoji} ` +
                `<b>${coin}</b>: ` +
                `${nearest.short} — ` +
                `<b>${formatDistance(nearest.distance)}</b>`
            );

        } catch (err) {
            console.error(
                `${coin}:`,
                err.message
            );

            lines.push(
                `❌ <b>${coin}</b>: ошибка`
            );
        }
    }

    return lines.join("\n");
}

async function sendCheckReport() {
    await sendTelegram(
        await createCheckReport()
    );
}


// ======================================================
// /LEVELS GRAPHICAL REPORT
// ======================================================

function createLevelsVisual(data) {
    const price =
        data.price;

    const levelObjects =
        getLevelObjects(
            data.levels
        );

    /*
        Сортируем четыре уровня + текущую цену
        сверху вниз по цене.
    */

    const items =
        [
            ...levelObjects.map(
                level => ({
                    type: "level",
                    value:
                        level.price,
                    level
                })
            ),

            {
                type: "price",
                value: price
            }
        ]
            .sort(
                (a, b) =>
                    b.value -
                    a.value
            );

    const lines = [];

    for (
        let i = 0;
        i < items.length;
        i++
    ) {
        const item =
            items[i];

        if (
            item.type ===
            "price"
        ) {
            lines.push(
                `🪙 <b>${data.coin}</b> ` +
                `<b>${formatPrice(price)}</b>`
            );

        } else {
            const level =
                item.level;

            const distance =
                getDistancePercent(
                    price,
                    level.price
                );

            lines.push(
                `${level.emoji} ` +
                `<b>${level.title}</b>\n` +
                `${formatPrice(level.price)} ` +
                `(${formatDistance(distance)})`
            );
        }

        if (
            i ===
            items.length - 1
        ) {
            continue;
        }

        const current =
            items[i];

        const next =
            items[i + 1];

        /*
            Обычный промежуток:
            две пустые строки.

            Между R0.5 и S0.5 визуально
            делаем пространство больше,
            если текущая цена не находится
            непосредственно между ними.
        */

        let blankLines = 2;

        if (
            current.type === "level" &&
            next.type === "level" &&
            current.level.key === "resistance05" &&
            next.level.key === "support05"
        ) {
            blankLines = 4;
        }

        lines.push(
            "\n".repeat(
                blankLines
            )
        );
    }

    return lines.join("\n");
}

async function sendLevelsReport(coin) {
    const normalized =
        normalizeCoin(coin);

    if (!normalized) {
        await sendTelegram(
            `Использование:\n` +
            `<code>/levels BTC</code>`
        );

        return;
    }

    const exists =
        await coinExists(
            normalized
        );

    if (!exists) {
        await sendTelegram(
            `❌ Пара <b>${normalized}USDT</b> не найдена.`
        );

        return;
    }

    const data =
        await getMarketData(
            normalized
        );

    const visual =
        createLevelsVisual(
            data
        );

    await sendTelegram(
        `<b>📐 ${normalized} — уровни на сегодня</b>\n\n` +

        `Предыдущий день:\n` +
        `High: ${formatPrice(data.previousDay.high)}\n` +
        `Low: ${formatPrice(data.previousDay.low)}\n\n\n` +

        visual
    );
}


// ======================================================
// COIN VALIDATION
// ======================================================

async function coinExists(coin) {
    const symbol =
        getSymbol(coin);

    try {
        const response =
            await fetch(
                `${BINANCE_API}` +
                `/api/v3/exchangeInfo` +
                `?symbol=${symbol}`
            );

        if (!response.ok) {
            return false;
        }

        const data =
            await response.json();

        return (
            Array.isArray(data.symbols) &&
            data.symbols.length > 0
        );

    } catch {
        return false;
    }
}


// ======================================================
// TELEGRAM COMMANDS
// ======================================================

let waitingForCoins = false;
let updateOffset = 0;

function commandMatches(
    text,
    command
) {
    return (
        text === command ||
        text.startsWith(
            `${command}@`
        )
    );
}

async function processTelegramMessage(
    message
) {
    if (!message) {
        return;
    }

    const chatId =
        String(
            message.chat?.id ||
            ""
        );

    const userId =
        String(
            message.from?.id ||
            ""
        );

    if (
        chatId !== USER_ID ||
        userId !== USER_ID
    ) {
        return;
    }

    const text =
        String(
            message.text ||
            ""
        ).trim();

    if (!text) {
        return;
    }


    // ==================================================
    // /START
    // ==================================================

    if (
        commandMatches(
            text,
            "/start"
        )
    ) {
        waitingForCoins =
            false;

        await sendTelegram(
            `<b>1D Range Monitor</b>\n\n` +

            `Уровни: <b>0.5 / 1.0</b>\n` +
            `Порог: <b>${TOUCH_THRESHOLD_PERCENT}%</b>\n` +
            `Проверка: раз в минуту\n\n` +

            `/check — ближайшие уровни\n` +
            `/levels BTC — уровни монеты\n` +
            `/coins — изменить монеты`
        );

        return;
    }


    // ==================================================
    // /CHECK
    // ==================================================

    if (
        commandMatches(
            text,
            "/check"
        )
    ) {
        waitingForCoins =
            false;

        await sendCheckReport();

        return;
    }


    // ==================================================
    // /LEVELS
    // ==================================================

    if (
        text.startsWith(
            "/levels"
        )
    ) {
        waitingForCoins =
            false;

        const parts =
            text.split(/\s+/);

        let coin =
            parts[1] || "";

        // На случай:
        // /levels@BotName BTC

        if (
            parts[0]
                .toLowerCase()
                .startsWith(
                    "/levels@"
                )
        ) {
            coin =
                parts[1] || "";
        }

        await sendLevelsReport(
            coin
        );

        return;
    }


    // ==================================================
    // /COINS
    // ==================================================

    if (
        commandMatches(
            text,
            "/coins"
        )
    ) {
        waitingForCoins =
            true;

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


    // ==================================================
    // NEW COIN LIST
    // ==================================================

    if (waitingForCoins) {
        const coins = [
            ...new Set(
                text
                    .split(",")
                    .map(normalizeCoin)
                    .filter(Boolean)
            )
        ];

        if (!coins.length) {
            await sendTelegram(
                "❌ Не удалось распознать список."
            );

            return;
        }

        const valid = [];
        const invalid = [];

        for (
            const coin
            of coins
        ) {
            const exists =
                await coinExists(
                    coin
                );

            if (exists) {
                valid.push(
                    coin
                );
            } else {
                invalid.push(
                    coin
                );
            }
        }

        if (!valid.length) {
            await sendTelegram(
                "❌ Ни одной USDT-пары не найдено."
            );

            return;
        }

        state.coins =
            valid;

        /*
            Удаляем старые touch-state
            для монет, которых больше нет.
        */

        for (
            const coin
            of Object.keys(
                state.touchState
            )
        ) {
            if (
                !valid.includes(
                    coin
                )
            ) {
                delete state.touchState[
                    coin
                ];
            }
        }

        saveState();

        waitingForCoins =
            false;

        let answer =
            `✅ <b>Список обновлён</b>\n\n` +
            `${valid.join(", ")}`;

        if (invalid.length) {
            answer +=
                `\n\n⚠️ Не найдены:\n` +
                `${invalid.join(", ")}`;
        }

        await sendTelegram(
            answer
        );

        return;
    }
}


// ======================================================
// TELEGRAM POLLING
// ======================================================

async function telegramPolling() {
    while (true) {
        try {
            const updates =
                await telegramRequest(
                    "getUpdates",
                    {
                        offset:
                            updateOffset,

                        timeout:
                            30,

                        allowed_updates:
                            ["message"]
                    }
                );

            for (
                const update
                of updates
            ) {
                updateOffset =
                    update.update_id +
                    1;

                await processTelegramMessage(
                    update.message
                );
            }

        } catch (err) {
            console.error(
                "Telegram polling:",
                err.message
            );

            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        3000
                    )
            );
        }
    }
}


// ======================================================
// STARTUP REPORT
// ======================================================

async function sendStartupReport() {
    const lines = [
        `<b>🚀 1D Range Monitor запущен</b>`,
        "",
        `Порог: <b>${TOUCH_THRESHOLD_PERCENT}%</b>`,
        `Проверка: <b>${CHECK_INTERVAL / 1000} сек.</b>`,
        "",
        `Монеты:`,
        `<b>${getCoins().join(", ")}</b>`
    ];

    await sendTelegram(
        lines.join("\n")
    );
}


// ======================================================
// MAIN
// ======================================================

async function main() {
    if (!BOT_TOKEN) {
        throw new Error(
            "Нет TELEGRAM_BOT_TOKEN"
        );
    }

    if (!USER_ID) {
        throw new Error(
            "Нет TELEGRAM_USER_ID"
        );
    }

    console.log(
        "1D Range Monitor"
    );

    console.log(
        "Монеты:",
        getCoins().join(", ")
    );

    console.log(
        "Touch threshold:",
        `${TOUCH_THRESHOLD_PERCENT}%`
    );

    console.log(
        "Check interval:",
        `${CHECK_INTERVAL / 1000}s`
    );


    await sendStartupReport();


    /*
        Сразу проверяем уровни.

        Если бот запускается прямо около уровня,
        он может прислать сигнал.
    */

    await checkAll();


    /*
        Затем раз в минуту.
    */

    setInterval(
        checkAll,
        CHECK_INTERVAL
    );


    telegramPolling();
}


main().catch(
    async err => {
        console.error(
            err
        );

        try {
            await sendTelegram(
                `❌ <b>Ошибка 1D Range Monitor</b>\n\n` +
                `${String(
                    err.message ||
                    err
                )}`
            );

        } catch {}
    }
);