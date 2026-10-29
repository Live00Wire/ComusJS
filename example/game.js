// ==========================================
// GAME.JS - Connect 4 Rules & Board Render
// 
// This file contains the pure logic for Connect 4.
// Notice how `renderGameBoard` relies ENTIRELY on 
// `engine.getState()`. It does not keep its own local 
// variables, ensuring perfect synchronization.
// ==========================================

/**
 * Returns a fresh 6x7 2D array filled with nulls.
 */
export function createEmptyBoard() {
  return Array(6).fill(null).map(() => Array(7).fill(null));
}

/**
 * Scans the board to see if a specific player has 4 tokens in a row.
 * Returns the winning coordinates if true, or null if false.
 */
export function checkWin(board, player) {
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      if (board[r][c] !== player) continue;
      
      // Horizontal, Vertical, Diagonal Right, Diagonal Left checks
      if (c + 3 < 7 && board[r][c+1] == player && board[r][c+2] == player && board[r][c+3] == player) return [[r,c], [r,c+1], [r,c+2], [r,c+3]];
      if (r + 3 < 6 && board[r+1][c] == player && board[r+2][c] == player && board[r+3][c] == player) return [[r,c], [r+1,c], [r+2,c], [r+3,c]];
      if (r + 3 < 6 && c + 3 < 7 && board[r+1][c+1] == player && board[r+2][c+2] == player && board[r+3][c+3] == player) return [[r,c], [r+1,c+1], [r+2,c+2], [r+3,c+3]];
      if (r + 3 < 6 && c - 3 >= 0 && board[r+1][c-1] == player && board[r+2][c-2] == player && board[r+3][c-3] == player) return [[r,c], [r+1,c-1], [r+2,c-2], [r+3,c-3]];
    }
  }
  return null;
}

/**
 * Renders the 6x7 DOM grid based strictly on the ComusJS state.
 */
export function renderGameBoard(engine, ui) {
  // 1. Pull the absolute truth from the Engine State
  const board = engine.getState('board');
  const p1 = engine.getState('p1');
  const p2 = engine.getState('p2');
  const winner = engine.getState('winner');
  const winningCells = engine.getState('winningCells') || [];
  const votes = engine.getState('rematchVotes') || [];
  
  const syncedQueue = engine.getState('turnQueue') || [];
  const activeTurnId = syncedQueue[engine.currentTurnIndex];

  if (!board) return;

  // UX: Change button text if they are the last person playing
  ui.leaveGameBtn.textContent = (engine.players.size <= 1) ? "Close Room" : "Leave Game";

  // 2. Render the top Status Text & Rematch Button
  if (winner) {
    if (winner === 'DRAW') ui.gameStatus.textContent = "It's a Draw!";
    else ui.gameStatus.textContent = winner === engine.myId ? "🎉 You Won!" : `${engine.players.get(winner).name} won!`;
    
    ui.rematchBtn.style.display = 'block';
    
    if (votes.includes(engine.myId)) {
      ui.rematchBtn.textContent = "Waiting for other player...";
      ui.rematchBtn.disabled = true;
      ui.rematchBtn.style.opacity = '0.7';
    } else {
      ui.rematchBtn.textContent = "Vote for Rematch";
      ui.rematchBtn.disabled = false;
      ui.rematchBtn.style.opacity = '1';
    }
  } else {
    ui.rematchBtn.style.display = 'none';
    if (engine.myId === activeTurnId) ui.gameStatus.textContent = "Your Turn!";
    else if (activeTurnId) ui.gameStatus.textContent = `Waiting for ${engine.players.get(activeTurnId).name}...`;
  }

  // 3. Render the 6x7 Grid
  ui.board.innerHTML = '';
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      const cell = document.createElement('div');
      cell.className = 'c4-cell';
      
      // Color the tokens
      if (board[r][c] === p1) cell.classList.add('token-p1');
      if (board[r][c] === p2) cell.classList.add('token-p2');

      // Highlight the winning row
      const isWinningCell = winningCells.some(([winR, winC]) => winR === r && winC === c);
      if (isWinningCell) cell.classList.add('winning-cell');

      // Add click listener (Sends an INTENT to the Host)
      cell.addEventListener('click', () => {
        if (!winner && engine.myId === activeTurnId) {
          // Send action to the Host for validation
          engine.sendAction({ type: 'DROP', column: c });
        }
      });
      
      ui.board.appendChild(cell);
    }
  }
}