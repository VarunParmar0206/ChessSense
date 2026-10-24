// ============================================================
// ChessSense
// Multiple contents have been comment-out
// ============================================================

let visualizerInterval = null;
let currentGameId = null;
let lastFen = null;
let isGameOver = false;
let currentTurn = 'white'; // track turn via move-list or FEN-change toggling

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

// ============================================================
// STOCKFISH ENGINE STATE
// ============================================================
let stockfishWorker = null;
let engineReady = false;
let currentEngineSearch = null;
let previousEngineFen = null;

// ── Engine config (Normal mode only) ──────────────────────
const ENGINE_DEPTH = 8;
const ENGINE_MULTIPV = 3;
const ENGINE_POLL_MS = 800;

// FIX: engineData now stores an array of lines instead of a single bestMove
let engineData = {
  lines: [],        // [{ move, depth }, ...]  index 0 = best
  thinking: false,
  pendingLines: {}  // accumulated while thinking, keyed by multipv number
};

// ============================================================
// STOCKFISH WORKER
// ============================================================

function initStockfishWorker() {
  if (stockfishWorker) return;
  try {
    const stockfishPath = chrome.runtime.getURL('stockfish.js');
    const workerBlob = new Blob([`importScripts('${stockfishPath}');`], {
      type: 'application/javascript'
    });
    stockfishWorker = new Worker(URL.createObjectURL(workerBlob));
    stockfishWorker.onmessage = handleStockfishMessage;
    stockfishWorker.onerror = (err) => {
      console.error('[Engine] Worker error:', err);
      engineReady = false;
    };
    sendToEngine('uci');
  } catch (err) {
    console.error('[Engine] Failed to initialize worker:', err);
    stockfishWorker = null;
    engineReady = false;
  }
}

function sendToEngine(command) {
  if (stockfishWorker) stockfishWorker.postMessage(command);
}

function handleStockfishMessage(event) {
  const msg = event.data;
  if (typeof msg !== 'string') return;

  if (msg === 'uciok') {
    engineReady = true;
    sendToEngine('ucinewgame');
    sendToEngine('setoption name MultiPV value ' + ENGINE_MULTIPV);
    sendToEngine('isready');
    return;
  }
  if (msg === 'readyok') return;
  parseEngineInfo(msg);
}

// FIX: completely rewritten to accumulate multiple PV lines
function parseEngineInfo(msg) {
  if (msg.startsWith('bestmove')) {
    // Search complete — commit pending lines
    const mpv = ENGINE_MULTIPV;
    engineData.lines = [];
    for (let i = 1; i <= mpv; i++) {
      if (engineData.pendingLines[i]) {
        engineData.lines.push(engineData.pendingLines[i]);
      }
    }
    engineData.thinking = false;
    engineData.pendingLines = {};
    currentEngineSearch = null;
    return;
  }

  // Only process lines that have a pv (skip seldepth / hashfull / nps lines)
  if (!msg.startsWith('info') || !msg.includes(' pv ') || !msg.includes('depth')) return;

  const depthMatch  = msg.match(/depth (\d+)/);
  const multipvMatch = msg.match(/multipv (\d+)/);
  const pvMatch     = msg.match(/ pv ([a-h][1-8][a-h][1-8][qrbn]?)/);
  if (!pvMatch) return;

  const pvLine = multipvMatch ? parseInt(multipvMatch[1]) : 1;
  const depth  = depthMatch  ? parseInt(depthMatch[1])   : 0;
  const move   = pvMatch[1];

  // Store the latest info for this pv line (higher depth = better)
  const existing = engineData.pendingLines[pvLine];
  if (!existing || depth >= existing.depth) {
    engineData.pendingLines[pvLine] = { move, depth };
  }
}

// ============================================================
// CASTLING RIGHTS INFERENCE (BUG FIX #4)
// ============================================================

// Infer castling rights from the current board state by checking
// whether kings and rooks are on their starting squares.
function inferCastlingRights(boardObj) {
  let rights = '';

  // White king on e1?
  if (boardObj['e1'] === 'wk') {
    if (boardObj['h1'] === 'wr') rights += 'K';
    if (boardObj['a1'] === 'wr') rights += 'Q';
  }
  // Black king on e8?
  if (boardObj['e8'] === 'bk') {
    if (boardObj['h8'] === 'br') rights += 'k';
    if (boardObj['a8'] === 'br') rights += 'q';
  }

  return rights || '-';
}

// FIX: turn is now passed in and used correctly (was always 'w')
// FIX: castling rights are inferred from the position instead of hardcoded
function analyzePosition(fen, turn, boardObj) {
  if (!engineReady || !stockfishWorker) return;

  const turnChar = turn === 'black' ? 'b' : 'w';
  const castling = boardObj ? inferCastlingRights(boardObj) : '-';
  const fullFen  = `${fen} ${turnChar} ${castling} - 0 1`;

  if (fullFen === previousEngineFen && !engineData.thinking) return;
  if (currentEngineSearch) sendToEngine('stop');

  previousEngineFen     = fullFen;
  engineData.thinking   = true;
  engineData.lines      = [];
  engineData.pendingLines = {};

  sendToEngine('position fen ' + fullFen);
  sendToEngine('go depth ' + ENGINE_DEPTH);
  currentEngineSearch = fullFen;
}

// ============================================================
// MODE SWITCHING
// ============================================================

function stopEngineSearch() {
  if (currentEngineSearch) sendToEngine('stop');
  engineData.thinking   = false;
  engineData.lines      = [];
  engineData.pendingLines = {};
  currentEngineSearch   = null;
  previousEngineFen     = null; // BUG FIX #7: clear so re-analysis isn't blocked
}

function terminateStockfishWorker() {
  if (stockfishWorker) {
    sendToEngine('quit');
    stockfishWorker.terminate();
    stockfishWorker       = null;
    engineReady           = false;
    currentEngineSearch   = null;
    previousEngineFen     = null;
  }
}

// ============================================================
// BOARD / DOM HELPERS
// ============================================================



// BUG FIX #5 & #10: Clean up flipped detection + use correct tag wc-chess-board
function getPlayerColor() {
  const board =
    document.querySelector('wc-chess-board') ||
    document.querySelector('.board')          ||
    document.querySelector('.board-layout-main');
  if (board) {
    // Chess.com uses the CSS class 'flipped' on the board element when playing black.
    // Also check for the boolean 'flipped' attribute (presence = flipped).
    const isFlipped =
      board.classList.contains('flipped')        ||
      board.classList.contains('board-flipped')   ||
      (board.hasAttribute('flipped') && board.getAttribute('flipped') !== 'false');
    if (isFlipped) return 'black';
  }
  // Fallback: if coordinate labels are present, '1' at top means board is flipped
  const rankLabels = document.querySelectorAll('.coordinates .coordinate-light, .coordinates .coordinate-dark');
  if (rankLabels.length >= 8) {
    // When playing as black, rank '8' is at the bottom (last label = '8')
    const lastLabel = rankLabels[rankLabels.length - 1]?.textContent?.trim();
    if (lastLabel === '8') return 'black';
  }
  return 'white';
}

function getBoardState() {
  const board = getChessBoard();
  if (!board) return {};
  const boardObj = {};
  for (let rank = 8; rank >= 1; rank--) {
    for (let file = 1; file <= 8; file++) {
      const el = board.querySelector(`.piece.square-${file}${rank}`);
      if (!el) continue;
      for (const cls of el.classList.values()) {
        if (cls.length === 2 && /^[wb][pnbrqk]$/.test(cls)) {
          boardObj['abcdefgh'[file - 1] + rank] = cls;
          break;
        }
      }
    }
  }
  return boardObj;
}

// BUG FIX #3: Handle case where pieceInPos stays as a DOMTokenList
function getFenString() {
  const board = getChessBoard();
  if (!board) return '';
  let fen = '';
  for (let rank = 8; rank >= 1; rank--) {
    for (let file = 1; file <= 8; file++) {
      let pieceCode = null; // will be a 2-char string like 'wp', or null
      const el = board.querySelector(`.piece.square-${file}${rank}`);
      if (el) {
        for (const item of el.classList.values()) {
          if (item.length === 2 && /^[wb][pnbrqk]$/.test(item)) {
            pieceCode = item;
            break;
          }
        }
        // If el exists but no matching class found (e.g. during animation),
        // pieceCode stays null — treat as empty square.
      }

      if (pieceCode === null) {
        // Empty square: increment the empty counter
        const prev = fen[fen.length - 1];
        if (prev && !isNaN(Number(prev)) && prev !== '/') {
          fen = fen.slice(0, -1) + (Number(prev) + 1);
        } else {
          fen += '1';
        }
      } else {
        fen += pieceCode[0] === 'b' ? pieceCode[1] : pieceCode[1].toUpperCase();
      }
    }
    if (rank !== 1) fen += '/';
  }
  return fen;
}

// BUG FIX #11: More robust game-over detection with partial-match selectors
// and button text detection for Chess.com's obfuscated class names
function detectGameOver() {
  // Strategy 1: well-known selectors and partial class matches
  const el =
    document.querySelector('[data-cy="game-over-status"]')       ||
    document.querySelector('[data-cy="game-over-modal"]')        ||
    document.querySelector('[data-test-element="game-over-modal"]') ||
    document.querySelector('div[class*="game-over"]')             ||
    document.querySelector('div[class*="board-modal"]')            ||
    document.querySelector('.game-over-banner')                   ||
    document.querySelector('.game-result')                        ||
    document.querySelector('.game-status')                        ||
    document.querySelector('.board-result')                       ||
    document.querySelector('.result-banner');

  if (el && /game over|checkmate|stalemate|draw|resigned|timeout|abandoned|wins|lost/i.test(el.textContent)) {
    return true;
  }

  // Strategy 2: detect "Game Review" / "New Game" / "Rematch" buttons
  // that only appear after a game ends
  const buttons = document.querySelectorAll('button, a[role="button"]');
  for (const btn of buttons) {
    if (/game review|new game|play again|rematch/i.test(btn.textContent?.trim())) {
      return true;
    }
  }

  return false;
}

function detectNewGame(fen, pieceCount) {
  return fen.startsWith(INITIAL_FEN) && pieceCount === 32;
}

function isGamePage() {
  return /\/(live|game|play|puzzles|analysis)/.test(window.location.href);
}

// ============================================================
// BUG FIX #2: TURN DETECTION FROM MOVE LIST
// ============================================================

// Read Chess.com's move list from the DOM to determine whose turn it is.
// The move list uses <div class="move"> elements with white/black move children.
// Falls back to FEN-toggle heuristic if the move list is not found.
function getTurnFromMoveList() {
  // Find all potential move list containers
  const moveLists = document.querySelectorAll(
    '.move-list-wrapper, vertical-move-list, wc-move-list, .move-list, [data-cy="move-list"]'
  );

  let activeMoveList = null;
  for (const ml of moveLists) {
    const rect = ml.getBoundingClientRect();
    // Select the first container that is actually visible on screen
    if (rect.width > 50 && rect.height > 50) {
      activeMoveList = ml;
      break;
    }
  }

  if (!activeMoveList) return null; // fallback to toggle if no visible list

  // Count individual half-moves inside the active visible list
  const moveNodes = activeMoveList.querySelectorAll(
    '.move-text-component, .node, [data-ply], [data-node], .white-move, .black-move'
  );

  if (moveNodes.length === 0) return null;

  // Even count = white's turn, Odd count = black's turn
  return moveNodes.length % 2 === 0 ? 'white' : 'black';
}

// ============================================================
// TURN DETECTION FROM BOARD HIGHLIGHTS (PRIMARY METHOD)
// ============================================================

// Chess.com highlights the from/to squares of the last move. The destination
// square will have a piece on it — its color tells us who just moved,
// so the *opposite* color is to move next.
function getTurnFromHighlights(boardObj) {
  const board = getChessBoard();
  if (!board) return null;

  // Chess.com renders .highlight elements over the last-move squares
  const highlights = board.querySelectorAll('.highlight');
  if (highlights.length === 0) return 'white'; // no moves played yet

  for (const hl of highlights) {
    const sqClass = Array.from(hl.classList).find(c => /^square-\d{2}$/.test(c));
    if (!sqClass) continue;
    const file = parseInt(sqClass.charAt(7)); // 1-8
    const rank = parseInt(sqClass.charAt(8)); // 1-8
    if (file < 1 || file > 8 || rank < 1 || rank > 8) continue;
    const squareName = 'abcdefgh'[file - 1] + rank;
    const piece = boardObj[squareName];
    if (piece) {
      // Piece on highlighted square = that color just moved → opposite turn
      return piece[0] === 'w' ? 'black' : 'white';
    }
  }

  return null; // couldn't determine (e.g. during animation)
}

// ============================================================
// ARROW DRAWING ON THE REAL CHESS BOARD
// ============================================================

// Colors: index 0 = best (red), 1 = 2nd (yellow), 2 = 3rd (green)
const ARROW_STYLES = [
  { color: '#e03030', opacity: 0.88 },
  { color: '#e8c000', opacity: 0.82 },
  { color: '#28b828', opacity: 0.78 }
];

// BUG FIX: Scope board queries to the active visible board to prevent matching stale/hidden boards
function getChessBoard() {
  const boards = document.querySelectorAll('wc-chess-board, .board, .board-area');
  for (const b of boards) {
    const rect = b.getBoundingClientRect();
    if (rect.width > 100 && rect.height > 100) {
      return b;
    }
  }
  return boards[0] || null;
}

// Convert a square name ("e4") to pixel coordinates within the board
function squareToXY(squareName, boardWidth, playerColor) {
  const file = squareName.charCodeAt(0) - 97; // a=0 … h=7
  const rank = parseInt(squareName[1]) - 1;   // 1=0 … 8=7
  const sz   = boardWidth / 8;
  if (playerColor === 'white') {
    return { x: (file + 0.5) * sz, y: (7 - rank + 0.5) * sz };
  } else {
    return { x: (7 - file + 0.5) * sz, y: (rank + 0.5) * sz };
  }
}

function buildArrowPoints(from, to, sz) {
  const dx  = to.x - from.x;
  const dy  = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;

  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;          // perpendicular
  const py = ux;

  const shaftW  = sz * 0.12;
  const headW   = sz * 0.24;
  const headLen = sz * 0.34;
  const start   = sz * 0.28; // gap at piece tail
  const end     = sz * 0.20; // gap at piece head

  const x1  = from.x + ux * start;
  const y1  = from.y + uy * start;
  const x2  = to.x   - ux * end;
  const y2  = to.y   - uy * end;
  const hbx = x2 - ux * headLen;
  const hby = y2 - uy * headLen;

  return [
    [x1   + px * shaftW, y1   + py * shaftW],
    [hbx  + px * shaftW, hby  + py * shaftW],
    [hbx  + px * headW,  hby  + py * headW ],
    [x2,                 y2                 ],
    [hbx  - px * headW,  hby  - py * headW ],
    [hbx  - px * shaftW, hby  - py * shaftW],
    [x1   - px * shaftW, y1   - py * shaftW],
  ].map(([ax, ay]) => `${ax.toFixed(1)},${ay.toFixed(1)}`).join(' ');
}

// BUG FIX #6: Anchor SVG to the board element with position:absolute
// instead of document.body with position:fixed (fixes scroll drift)
function updateBoardArrows(playerColor) {
  // Remove old SVG overlay
  const old = document.getElementById('sf-arrows-svg');
  if (old) old.remove();

  // Only draw when it's the player's turn and the engine has results
  if (currentTurn !== playerColor) return;
  if (!engineData.lines.length)    return;

  const board = getChessBoard();
  if (!board) return;

  const rect = board.getBoundingClientRect();
  if (rect.width < 10) return;

  // Ensure the board element has position context for absolute children
  const boardPos = getComputedStyle(board).position;
  if (boardPos === 'static') {
    board.style.position = 'relative';
  }

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'sf-arrows-svg';
  svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
  svg.style.cssText = `
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 100;
  `;

  // Draw worst→best so the best arrow renders on top
  const maxArrows = ENGINE_MULTIPV;
  const lines = engineData.lines.slice(0, maxArrows);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.move || line.move.length < 4) continue;

    const fromPt = squareToXY(line.move.slice(0, 2), rect.width, playerColor);
    const toPt   = squareToXY(line.move.slice(2, 4), rect.width, playerColor);
    const pts    = buildArrowPoints(fromPt, toPt, rect.width / 8);
    if (!pts) continue;

    const style  = ARROW_STYLES[i] || ARROW_STYLES[2];
    const poly   = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points', pts);
    poly.setAttribute('fill', style.color);
    poly.setAttribute('opacity', String(style.opacity));
    poly.setAttribute('stroke', 'rgba(0,0,0,0.35)');
    poly.setAttribute('stroke-width', '1');
    poly.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(poly);
  }

  board.appendChild(svg);
}

// BUG FIX #8 & #9: Redraw arrows on resize and scroll instead of just repositioning
function redrawArrowsIfNeeded() {
  const existing = document.getElementById('sf-arrows-svg');
  if (!existing) return;
  const playerColor = getPlayerColor();
  updateBoardArrows(playerColor);
}

window.addEventListener('resize', redrawArrowsIfNeeded, { passive: true });
window.addEventListener('scroll', redrawArrowsIfNeeded, { passive: true });

// ============================================================
// SIDEBAR OVERLAY PANEL (removed)
// ============================================================

// ============================================================
// MAIN REFRESH LOOP
// ============================================================

function refreshVisualizerLoop() {
  try {
    if (!isGamePage()) { stopVisualizer(); return; }

    const playerColor = getPlayerColor();
    const boardObj    = getBoardState();
    const pieceCount  = Object.keys(boardObj).length;

    if (pieceCount === 0) {
      removeOverlays();
      currentGameId = null; lastFen = null;
      isGameOver = false;   currentTurn = 'white';
      return;
    }

    const fen = getFenString();

    // New session bootstrap
    if (!currentGameId) {
      currentGameId = Date.now();
      isGameOver    = false;
      lastFen       = null;
      currentTurn   = 'white';
    }

    if (!isGameOver && detectGameOver()) {
      isGameOver = true;
      lastFen    = fen;
      stopEngineSearch();
    }

    if (isGameOver && detectNewGame(fen, pieceCount)) {
      currentGameId = Date.now();
      isGameOver    = false;
      lastFen       = null;
      currentTurn   = 'white';
    }

    // BUG FIX #13: Prefer highlight-based turn detection (most reliable),
    // then move-list count, then toggle heuristic as last resort.
    if (!isGameOver && fen !== lastFen) {
      const highlightTurn = getTurnFromHighlights(boardObj);
      if (highlightTurn !== null) {
        currentTurn = highlightTurn;
      } else {
        const moveListTurn = getTurnFromMoveList();
        if (moveListTurn !== null) {
          currentTurn = moveListTurn;
        } else if (lastFen === null) {
          currentTurn = 'white'; // game just started
        } else {
          currentTurn = currentTurn === 'white' ? 'black' : 'white';
        }
      }

      // Only analyze when it's the player's turn
      if (currentTurn === playerColor) {
        analyzePosition(fen, currentTurn, boardObj);
      } else {
        // Clear stale suggestions when it's opponent's turn
        stopEngineSearch();
      }
    }

    lastFen = fen;

    // Live board overlay removed — arrows + engine analysis still active
    document.getElementById('chess-live-board-overlay')?.remove();

    // BUG FIX #1: Actually call updateBoardArrows — was defined but never invoked!
    updateBoardArrows(playerColor);

  } catch (e) {
    console.error('[Chess Visualizer]', e);
  }
}

// ============================================================
// LIFECYCLE HELPERS
// ============================================================

function removeOverlays() {
  document.getElementById('chess-live-board-overlay')?.remove();
  document.getElementById('sf-arrows-svg')?.remove(); // always clean up even if arrows disabled
}

function stopVisualizer() {
  if (visualizerInterval) { clearInterval(visualizerInterval); visualizerInterval = null; }
  removeOverlays();
  currentGameId = null; lastFen = null;
  isGameOver    = false; currentTurn = 'white';
}

function startVisualizer() {
  if (visualizerInterval) return; // already running
  if (!stockfishWorker)   initStockfishWorker();
  refreshVisualizerLoop();
  visualizerInterval = setInterval(refreshVisualizerLoop, ENGINE_POLL_MS);
  console.log('[Chess Visualizer] Started');
}

// ============================================================
// FIX: SPA NAVIGATION — chess.com never does a full page reload
// Use two strategies: URL polling + chess-board DOM appearance
// ============================================================

let lastHref = window.location.href;

// Strategy 1: watch for URL changes via MutationObserver on <title>
// (cheap — title always changes on SPA navigation)
const navObserver = new MutationObserver(() => {
  const href = window.location.href;
  if (href === lastHref) return;
  lastHref = href;
  console.log('[Chess Visualizer] URL changed:', href);
  if (isGamePage()) {
    stopVisualizer(); // reset state cleanly
    setTimeout(startVisualizer, 1200);
  } else {
    stopVisualizer();
  }
});
navObserver.observe(document.querySelector('head') || document, {
  childList: true, subtree: true
});

// Strategy 2: watch for chess-board element appearing in the DOM
// (catches game loads where URL may not change, e.g. "Play again")
// BUG FIX #12: Use correct tag name wc-chess-board
const boardObserver = new MutationObserver((mutations) => {
  if (visualizerInterval) return; // already running, ignore
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      const hasBoard =
        node.matches?.('wc-chess-board')    || node.querySelector?.('wc-chess-board') ||
        node.matches?.('.board')            || node.querySelector?.('.board');
      if (hasBoard && isGamePage()) {
        console.log('[Chess Visualizer] Board element detected in DOM');
        setTimeout(startVisualizer, 800);
        return;
      }
    }
  }
});
boardObserver.observe(document.body, { childList: true, subtree: true });

// ============================================================
// INIT
// ============================================================
(function init() {
  initStockfishWorker();
  if (isGamePage()) {
    setTimeout(startVisualizer, 2000);
  }
})();

window.addEventListener('beforeunload', () => {
  terminateStockfishWorker();
  navObserver.disconnect();
  boardObserver.disconnect();
});