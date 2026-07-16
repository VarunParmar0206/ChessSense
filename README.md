# ♟️ ChessSense - Real-Time Chess Analysis Extension

A Chrome Extension that provides **real-time chess analysis** on **Chess.com** using the **Stockfish** chess engine.

ChessSense automatically detects the current board position, converts it into **FEN notation**, sends it to an embedded Stockfish engine running locally through **WebAssembly**, and displays engine evaluations and best move suggestions directly on the game board.

---

## 🚀 Features

- ♟️ Real-time Chess.com board detection
- ⚡ Live Stockfish engine analysis
- 📊 Position evaluation (Centipawn / Mate)
- 🎯 Best move suggestions
- 🔥 MultiPV analysis support
- 🏃 Normal & Bullet engine modes
- 🔄 Automatic board synchronization
- 🧠 Automatic FEN generation
- 👑 Castling rights detection
- 🎨 Interactive on-board overlay
- 🚀 Runs completely inside your browser
- 🔒 No external servers or APIs required

---

## 📸 Screenshots

screenshots/
├── engine-overlay.png

## 🛠 Tech Stack

- JavaScript (ES6)
- Chrome Extension (Manifest V3)
- Stockfish Engine
- WebAssembly (WASM)
- Web Workers
- HTML
- CSS

---

## ⚙️ How It Works

```text
Chess.com Board
        │
        ▼
Board State Detection
        │
        ▼
FEN Generator
        │
        ▼
Stockfish Engine
        │
        ▼
Engine Analysis
        │
        ▼
Visual Overlay
```

The extension continuously monitors the Chess.com board, extracts piece positions, generates a valid FEN string, sends it to Stockfish for evaluation, and renders the engine analysis directly within the game interface.

---

## 📂 Project Structure

```
ChessSense/
│
├── manifest.json
├── content.js
├── stockfish.js
├── stockfish.wasm
├── screenshots/
└── README.md
```

---

## 🔧 Installation

### Clone the Repository

```bash
git clone https://github.com/VarunParmar0206/ChessSense.git
```

### Load the Extension

1. Open Google Chrome

2. Navigate to

```
chrome://extensions
```

3. Enable **Developer Mode**

4. Click **Load unpacked**

5. Select the ChessSense project folder

6. Open **https://www.chess.com**

7. Start a game and the extension will begin analyzing positions automatically.

---

## 💡 Key Functionalities

### Live Board Detection

Automatically reads every move played on Chess.com.

### Automatic FEN Generation

Creates a valid FEN representation from the current board position.

### Embedded Stockfish Engine

Runs Stockfish locally using WebAssembly and Web Workers.

### Real-Time Analysis

Continuously evaluates the current position after every move.

### MultiPV Analysis

Displays multiple candidate moves along with engine evaluations.

### Engine Modes

- Normal Mode
- Bullet Mode

### Interactive Overlay

Shows evaluations, principal variations, and engine recommendations directly on the Chess.com interface.

---

## 🚀 Future Improvements

- Opening Explorer
- Endgame Tablebases
- Move History Analysis
- Evaluation Graph
- Engine Strength Slider
- Puzzle Mode
- Cloud Engine Support
- Dark Theme
- Keyboard Shortcuts

---

## 🤝 Contributing

Contributions, suggestions, and improvements are welcome.

Feel free to fork the repository and submit a pull request.

---

## 📜 License

This project uses the Stockfish chess engine.

Please refer to the Stockfish project for licensing information regarding the engine.

---

## 👨‍💻 Author

**Varun Parmar**

📧 Email: **varunparmar602@gmail.com**

🔗 LinkedIn: **https://linkedin.com/in/varunparmar0206**

💻 GitHub: **https://github.com/VarunParmar0206**
