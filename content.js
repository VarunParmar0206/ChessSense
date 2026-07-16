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

// ── Engine mode: 'normal' or 'bullet' ──────────────────────
const ENGINE_MODES = {
  normal: { depth: 8, multipv: 3, label: 'Normal',  pollMs: 800 },
  bullet: { depth: 3, multipv: 1, label: '⚡ Bullet', pollMs: 500 },
};
let engineMode = 'normal'; // active mode key

function getActiveConfig() {
  return ENGINE_MODES[engineMode] || ENGINE_MODES.normal;
}

// FIX: engineData now stores an array of lines instead of a single bestMove
let engineData = {
  lines: [],        // [{ move, evaluation, mate, depth }, ...]  index 0 = best
  thinking: false,
  depth: 0,
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
    sendToEngine('setoption name MultiPV value ' + getActiveConfig().multipv);
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
    const mpv = getActiveConfig().multipv;
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

  let evaluation = null;
  let mate       = null;
  const cpMatch   = msg.match(/score cp (-?\d+)/);
  const mateMatch = msg.match(/score mate (-?\d+)/);
  if (cpMatch)   evaluation = (parseInt(cpMatch[1]) / 100).toFixed(2);
  if (mateMatch) mate       = parseInt(mateMatch[1]);

  // Store the latest info for this pv line (higher depth = better)
  const existing = engineData.pendingLines[pvLine];
  if (!existing || depth >= existing.depth) {
    engineData.pendingLines[pvLine] = { move, evaluation, mate, depth };
  }
  if (depth > engineData.depth) engineData.depth = depth;
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

  const cfg = getActiveConfig();
  const turnChar = turn === 'black' ? 'b' : 'w';
  const castling = boardObj ? inferCastlingRights(boardObj) : '-';
  const fullFen  = `${fen} ${turnChar} ${castling} - 0 1`;

  if (fullFen === previousEngineFen && !engineData.thinking) return;
  if (currentEngineSearch) sendToEngine('stop');

  previousEngineFen     = fullFen;
  engineData.thinking   = true;
  engineData.lines      = [];
  engineData.pendingLines = {};
  engineData.depth      = 0;

  sendToEngine('position fen ' + fullFen);
  sendToEngine('go depth ' + cfg.depth);
  currentEngineSearch = fullFen;
}

// ============================================================
// MODE SWITCHING
// ============================================================

function setEngineMode(mode) {
  if (!ENGINE_MODES[mode] || mode === engineMode) return;
  engineMode = mode;
  const cfg = getActiveConfig();

  // Reconfigure the engine's MultiPV setting
  if (currentEngineSearch) sendToEngine('stop');
  sendToEngine('setoption name MultiPV value ' + cfg.multipv);
  sendToEngine('isready');

  // Clear stale results so arrows/panel update immediately
  engineData.lines      = [];
  engineData.pendingLines = {};
  engineData.depth      = 0;
  currentEngineSearch   = null;
  previousEngineFen     = null;

  // Restart the polling interval at the mode's speed
  if (visualizerInterval) {
    clearInterval(visualizerInterval);
    visualizerInterval = setInterval(refreshVisualizerLoop, cfg.pollMs);
  }

  console.log(`[Chess Visualizer] Switched to ${cfg.label} mode (depth ${cfg.depth}, multipv ${cfg.multipv})`);
}

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

function pieceToUnicode(piece) {
  const map = {
    wp:'♙', wn:'♘', wb:'♗', wr:'♖', wq:'♕', wk:'♔',
    bp:'♟', bn:'♞', bb:'♝', br:'♜', bq:'♛', bk:'♚'
  };
  return map[piece] || '';
}

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

function boardObjToMatrix(boardObj, playerColor) {
  const ranks = playerColor === 'black'
    ? ['1','2','3','4','5','6','7','8']
    : ['8','7','6','5','4','3','2','1'];
  const files = playerColor === 'black'
    ? ['h','g','f','e','d','c','b','a']
    : ['a','b','c','d','e','f','g','h'];
  return ranks.map(r => files.map(f => boardObj[f + r] || ''));
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

function formatMove(uciMove) {
  if (!uciMove || uciMove.length < 4) return uciMove || '—';
  const promo = uciMove.length > 4 ? uciMove[4].toUpperCase() : '';
  return `${uciMove.slice(0, 2)}→${uciMove.slice(2, 4)}${promo}`;
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
  const maxArrows = getActiveConfig().multipv;
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
// SIDEBAR OVERLAY PANEL
// ============================================================

function createVisualizationOverlay(matrix, fen, pieceCount, playerColor) {
  let overlay = document.getElementById('chess-live-board-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'chess-live-board-overlay';
    overlay.style.cssText = `
      position: fixed; top: 10px; right: 10px;
      z-index: 2147483647;
      background: #1a1a2e;
      padding: 10px 12px 8px 12px;
      border-radius: 8px; color: #fff;
      font-family: monospace;
      box-shadow: 0 4px 24px rgba(0,0,0,0.85);
      border: 1px solid #3a3a5c;
      user-select: none;
    `;
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = '';

  // ── Title ──────────────────────────────────────────────────
  const statusText = isGameOver ? ' · GAME OVER' : '';
  const title = document.createElement('div');
  title.textContent = `BOARD · ${playerColor === 'black' ? 'Black' : 'White'}${statusText}`;
  title.style.cssText = `
    text-align:center; margin-bottom:8px; font-size:11px;
    font-weight:bold; color:#a0c4ff; letter-spacing:2px;
  `;
  overlay.appendChild(title);

  // ── Mode toggle switch ────────────────────────────────────
  const toggleRow = document.createElement('div');
  toggleRow.style.cssText = `
    display:flex; align-items:center; justify-content:center;
    margin-bottom:8px; gap:8px;
  `;

  const normalLabel = document.createElement('span');
  normalLabel.textContent = '🎯 Normal';
  normalLabel.style.cssText = `
    font-size:10px; font-weight:bold; cursor:pointer;
    color:${engineMode === 'normal' ? '#a0c4ff' : '#555'};
    transition: color 0.2s;
  `;
  normalLabel.addEventListener('click', () => setEngineMode('normal'));

  const toggleTrack = document.createElement('div');
  toggleTrack.style.cssText = `
    width:36px; height:18px; border-radius:9px; cursor:pointer;
    background:${engineMode === 'bullet' ? '#f59e0b' : '#3a3a5c'};
    position:relative; transition: background 0.3s;
    box-shadow: inset 0 1px 3px rgba(0,0,0,0.4);
  `;
  const toggleKnob = document.createElement('div');
  toggleKnob.style.cssText = `
    width:14px; height:14px; border-radius:50%;
    background:#fff; position:absolute; top:2px;
    left:${engineMode === 'bullet' ? '20px' : '2px'};
    transition: left 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    box-shadow: 0 1px 3px rgba(0,0,0,0.4);
  `;
  toggleTrack.appendChild(toggleKnob);
  toggleTrack.addEventListener('click', () => {
    setEngineMode(engineMode === 'normal' ? 'bullet' : 'normal');
  });

  const bulletLabel = document.createElement('span');
  bulletLabel.textContent = '⚡ Bullet';
  bulletLabel.style.cssText = `
    font-size:10px; font-weight:bold; cursor:pointer;
    color:${engineMode === 'bullet' ? '#f59e0b' : '#555'};
    transition: color 0.2s;
  `;
  bulletLabel.addEventListener('click', () => setEngineMode('bullet'));

  toggleRow.appendChild(normalLabel);
  toggleRow.appendChild(toggleTrack);
  toggleRow.appendChild(bulletLabel);
  overlay.appendChild(toggleRow);

  // ── Mini board ─────────────────────────────────────────────
  const files = playerColor === 'black'
    ? ['h','g','f','e','d','c','b','a']
    : ['a','b','c','d','e','f','g','h'];
  const ranks = playerColor === 'black'
    ? ['1','2','3','4','5','6','7','8']
    : ['8','7','6','5','4','3','2','1'];

  const boardWrapper = document.createElement('div');
  boardWrapper.style.cssText = 'display:inline-block;';

  for (let r = 0; r < 8; r++) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center;';

    const rl = document.createElement('div');
    rl.textContent = ranks[r];
    rl.style.cssText = 'width:14px; font-size:9px; color:#777; text-align:right; padding-right:3px; flex-shrink:0;';
    row.appendChild(rl);

    for (let c = 0; c < 8; c++) {
      const cell = document.createElement('div');
      cell.style.cssText = `
        width:32px; height:32px; display:flex;
        align-items:center; justify-content:center;
        background:${(r + c) % 2 === 0 ? '#f0d9b5' : '#b58863'};
        position:relative; flex-shrink:0;
      `;
      const piece = matrix[r][c];
      if (piece) {
        const span = document.createElement('span');
        span.textContent = pieceToUnicode(piece);
        span.style.cssText = `
          font-size:22px; line-height:1;
          position:absolute; top:50%; left:50%;
          transform:translate(-50%,-50%);
          filter:drop-shadow(0 1px 1px ${
            piece[0] === 'w' ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.5)'
          });
        `;
        cell.appendChild(span);
      }
      row.appendChild(cell);
    }
    boardWrapper.appendChild(row);
  }

  const fileRow = document.createElement('div');
  fileRow.style.cssText = 'display:flex; margin-left:17px; margin-top:2px;';
  files.forEach(f => {
    const fl = document.createElement('div');
    fl.textContent = f;
    fl.style.cssText = 'width:32px; font-size:9px; color:#777; text-align:center;';
    fileRow.appendChild(fl);
  });
  boardWrapper.appendChild(fileRow);
  overlay.appendChild(boardWrapper);

  // ── Stats / engine panel ────────────────────────────────────
  const stats = document.createElement('div');
  stats.style.cssText = 'margin-top:8px; text-align:center;';

  const countLine = document.createElement('div');
  countLine.textContent = `${pieceCount} pieces on board`;
  countLine.style.cssText = 'font-size:10px; color:#aaa;';
  stats.appendChild(countLine);

  const enginePanel = document.createElement('div');
  enginePanel.style.cssText = `
    margin-top:6px; padding:6px 8px;
    background:#0d0d1a; border:1px solid #2a2a5c; border-radius:4px;
  `;

  // Engine status line
  const engineStatus = document.createElement('div');
  engineStatus.style.cssText = 'font-size:9px; color:#7fb3ff; margin-bottom:4px;';
  const modeTag = engineMode === 'bullet' ? ' [⚡ Bullet]' : '';
  if (!engineReady) {
    engineStatus.textContent = '⚙ Engine: Initializing...';
  } else if (engineData.thinking) {
    engineStatus.textContent = `⚙ Engine: Thinking… (depth ${engineData.depth})${modeTag}`;
  } else {
    engineStatus.textContent = `⚙ Engine: Ready (depth ${engineData.depth})${modeTag}`;
  }
  enginePanel.appendChild(engineStatus);

  // Move lines (color-coded to match arrows)
  const lineStyles = [
    { dot: '🔴', label: 'Best', color: '#ff6666' },
    { dot: '🟡', label: '2nd',  color: '#ffcc44' },
    { dot: '🟢', label: '3rd',  color: '#66dd66' },
  ];

  const maxLines = getActiveConfig().multipv;
  if (engineData.lines.length > 0) {
    engineData.lines.slice(0, maxLines).forEach((line, i) => {
      const row = document.createElement('div');
      row.style.cssText = `
        display:flex; justify-content:space-between;
        font-size:11px; color:${lineStyles[i].color};
        font-weight:bold; margin-top:3px;
      `;
      const lbl = document.createElement('span');
      lbl.textContent = `${lineStyles[i].dot} ${lineStyles[i].label}: ${formatMove(line.move)}`;

      const ev = document.createElement('span');
      ev.style.cssText = 'font-size:10px; font-weight:normal; color:#aaa;';
      if (line.mate !== null) {
        ev.textContent = `M${Math.abs(line.mate)}`;
      } else if (line.evaluation !== null) {
        const v = parseFloat(line.evaluation);
        ev.textContent = `${v > 0 ? '+' : ''}${line.evaluation}`;
      }
      row.appendChild(lbl);
      row.appendChild(ev);
      enginePanel.appendChild(row);
    });
  } else {
    const noMove = document.createElement('div');
    noMove.style.cssText = 'font-size:10px; color:#666; margin-top:3px;';
    noMove.textContent = currentTurn === playerColor ? 'Analyzing…' : "Opponent's turn";
    enginePanel.appendChild(noMove);
  }

  stats.appendChild(enginePanel);

  // FEN copy box
  const fenBox = document.createElement('div');
  fenBox.textContent = fen;
  fenBox.title = 'Click to copy FEN';
  fenBox.style.cssText = `
    font-size:7.5px; color:#666; margin-top:4px;
    word-break:break-all; cursor:pointer;
    padding:3px 4px; background:#111;
    border-radius:3px; border:1px solid #2a2a4a; max-width:258px;
  `;
  fenBox.addEventListener('click', () => {
    navigator.clipboard.writeText(fen).then(() => {
      fenBox.style.color = '#7fff7f';
      setTimeout(() => { fenBox.style.color = '#666'; }, 1000);
    });
  });
  stats.appendChild(fenBox);
  overlay.appendChild(stats);
}

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
    const fenToShow = isGameOver && lastFen ? lastFen : fen;
    const matrix    = boardObjToMatrix(boardObj, playerColor);

    // Live board overlay hidden — arrows + engine analysis still active
    // createVisualizationOverlay(matrix, fenToShow, pieceCount, playerColor);
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
  visualizerInterval = setInterval(refreshVisualizerLoop, getActiveConfig().pollMs);
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