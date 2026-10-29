# ComusJS
[![npm](https://img.shields.io/npm/v/comusjs)](https://www.npmjs.com/package/comusjs) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Build resilient, host-authoritative peer-to-peer multiplayer games in JavaScript over WebRTC. No dedicated servers required!

<p align="center">
  <a href="https://live00wire.github.io/ComusJS/example"><img src="./media/connect4-demo.gif"></a>
</p>
<p align="center">
  <a href="https://live00wire.github.io/ComusJS/example/">[CHECK OUT THE CONNECT 4 DEMO]</a>
</p>

## Quick Start

Here's how ComusJS works:

- You create your game using standard frontend HTML/JS.
- You can use any HTML5 rendering method (Canvas, DOM, SVG, Three.js).
- You host your game anywhere (GitHub Pages, Vercel, Netlify, Itch.io).
- ComusJS handles the WebRTC handshakes, host-election, and state synchronization.

Unlike traditional lockstep peer-to-peer engines, ComusJS uses a **Host-Authoritative** model. One player is seamlessly elected as the Host to validate moves and prevent cheating. If they disconnect, the engine automatically migrates the host duties to another player without dropping the game state.

Let's look at a simple implementation:

    <script type="module">
      import { ComusJS } from "https://unpkg.com/comusjs/dist/comus.js";

      // 1. Initialize the engine
      const engine = new ComusJS({ name: "Player 1", enableDeepLinks: true });

      // 2. Define exactly what constitutes a valid move (Host Only)
      engine.useActionValidator((action, senderId, state) => {
        if (action.type === 'INCREMENT') {
          return state.clicks < 10; // Prevent clicking past 10
        }
        return false;
      });

      // 3. Process the action and broadcast the new state (Host Only)
      engine.on('actionReceived', ({ action, senderId }) => {
        if (action.type === 'INCREMENT') {
          const currentClicks = engine.getState('clicks') || 0;
          engine.setState('clicks', currentClicks + 1);
        }
      });

      // 4. React to state changes (All Clients)
      engine.on('stateChanged', () => {
        document.getElementById('score').innerText = engine.getState('clicks');
      });

      // 5. Create a room and initialize state
      engine.createRoom();
      engine.on('roomCreated', (roomId) => {
        console.log(`Room created! Join at ?room=${roomId}`);
        engine.setState('clicks', 0);
      });
    </script>

And voila - you have a fully synchronized, cheat-proof multiplayer state running entirely in the browser.

## Overview

ComusJS is designed to make WebRTC game development frictionless. It consists of the core engine and a reference implementation to help you get started.

- `comus.js` - The core, dependency-free engine. Drop this single file into your projects.
- `/example` - A fully featured Connect 4 game built with ComusJS.
  - Features real-time state synchronization, turn queues, URL deep-linking, global chat, and SVG avatars.

## Installation

For simple usage, you can import ComusJS directly via a CDN in your HTML files:

    <script type="module">
      import { ComusJS } from "https://unpkg.com/comusjs/dist/comus.js";
    </script>

For larger projects, you should install ComusJS from npm and bundle it with your application using Webpack, Vite, or a similar module bundler:

    npm install --save comusjs

## Usage

To create a game using ComusJS, you instantiate the engine and bind to its event emitters.

### State Management
State is strictly controlled by the Host. Clients cannot mutate state directly; they must send actions to the Host.

    // Clients send intents
    engine.sendAction({ type: 'DROP_TOKEN', column: 3 });

    // The Host mutates the state, which automatically syncs to all clients
    engine.setState('board', newBoardArray);

### Turn Management
ComusJS includes a built-in turn queue for turn-based games.

    engine.turnQueue = [player1Id, player2Id];
    engine.advanceTurn(1); // Passes the turn to the next player

### Real-Time Tickers
For real-time games, the Host can spin up a deterministic ticker loop that broadcasts to all clients.

    engine.startTicker(30); // Runs at 30 FPS
    engine.on('tick', () => {
      // Update physics, broadcast state
    });

## FAQ

### Does ComusJS require a dedicated server?
No! ComusJS uses a free, public PeerJS signaling server strictly for the initial handshake to connect players. Once connected, all gameplay data is sent peer-to-peer directly between browsers. You never have to pay for server hosting.

### What happens if the Host rage-quits or their Wi-Fi drops?
ComusJS features **Deterministic Host Migration**. If the current Host disconnects, the engine detects the drop (usually within milliseconds) and automatically elects a new Host from the remaining players. The new Host assumes authority, and the game continues seamlessly from the exact state it was in before the disconnect.

### How does it prevent cheating?
Because ComusJS is Host-Authoritative, modified client code cannot force invalid state changes. You define the rules using `engine.useActionValidator()`. If a hacked client tries to send an invalid action (like moving out of turn or placing a token in a full column), the Host silently rejects the packet and the game state remains pure.

## Assets Used from Other Projects
This repo utilizes the excellent [PeerJS](https://peerjs.com/) library for WebRTC signaling and connection abstraction.