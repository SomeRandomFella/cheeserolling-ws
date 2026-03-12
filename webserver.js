const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

const lobbies = {};
const players = {};

// THIS WAS A PAIN

console.log(`pookie running on  ${PORT}`);

wss.on("connection", (ws) => {
  let playerID = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case "register": {
        playerID = msg.playerID;
        players[playerID] = {
          ws,
          lobbyID: null,
          name: msg.name,
          skin: msg.skin,
        };
        send(ws, { type: "registered", playerID });
        break;
      }

      case "create_lobby": {
        if (!playerID) return;
        if (!players[playerID]) {
          console.warn("Player not registered:", playerID);
          send(ws, { type: "error", message: "Not registered" });
          return;
        }
        const lobbyID = uuidv4();
        lobbies[lobbyID] = {
          id: lobbyID,
          name: msg.name,
          hostID: playerID,
          maxPlayers: msg.maxPlayers,
          version: msg.version,
          grabbingAllowed: msg.grabbingAllowed,
          gameMode: msg.gameMode,
          members: new Map([[playerID, ws]]),
          data: {},
        };
        players[playerID].lobbyID = lobbyID;
        send(ws, { type: "lobby_created", lobbyID });
        break;
      }
      case "join_lobby": {
        if (!playerID || !players[playerID]) return;
        const lobby = lobbies[msg.lobbyID];
        if (!lobby) {
          send(ws, { type: "error", message: "Lobby not found" });
          return;
        }
        if (lobby.version !== msg.version) {
          send(ws, { type: "error", message: "Version mismatch" });
          return;
        }
        if (lobby.members.size >= lobby.maxPlayers) {
          send(ws, { type: "error", message: "Lobby full" });
          return;
        }

        lobby.members.set(playerID, ws);
        players[playerID].lobbyID = msg.lobbyID;

        send(ws, {
          type: "lobby_joined",
          lobbyID: msg.lobbyID,
          hostID: lobby.hostID,
          members: [...lobby.members.keys()].filter((id) => id !== playerID),
          grabbingAllowed: lobby.grabbingAllowed,
          name: lobby.name,
        });

        broadcast(lobby, playerID, {
          type: "member_joined",
          playerID,
          name: players[playerID].name,
          skin: players[playerID].skin,
        });
        break;
      }

      case "leave_lobby": {
        handleLeave(playerID);
        break;
      }

      case "relay": {
        if (!playerID || !players[playerID]) return;
        const lobbyID = players[playerID]?.lobbyID;
        const lobby = lobbies[lobbyID];
        if (!lobby) return;
        console.log(
          `Relay from ${playerID} to ${msg.to || "all"}, size: ${msg.data?.length}`,
        );
        if (msg.to) {
          const targetWs = lobby.members.get(msg.to);
          if (targetWs)
            send(targetWs, {
              type: "relay",
              from: playerID,
              data: msg.data,
            });
        } else {
          broadcast(lobby, playerID, {
            type: "relay",
            from: playerID,
            data: msg.data,
          });
        }
        break;
      }

      case "list_lobbies": {
        const result = Object.values(lobbies)
          .filter(
            (l) => l.version === msg.version && l.members.size < l.maxPlayers,
          )
          .map((l) => ({
            id: l.id,
            name: l.name,
            players: l.members.size,
            maxPlayers: l.maxPlayers,
            gameMode: l.gameMode,
          }));
        send(ws, { type: "lobby_list", lobbies: result });
        break;
      }

      case "set_member_data": {
        if (!playerID) return;
        const lobbyID = players[playerID]?.lobbyID;
        const lobby = lobbies[lobbyID];
        if (!lobby) return;
        broadcast(lobby, null, {
          type: "member_data",
          playerID,
          key: msg.key,
          value: msg.value,
        });
        break;
      }
    }
  });

  ws.on("close", () => {
    if (playerID) handleLeave(playerID);
  });

  ws.on("error", (err) => {
    console.error("WS error:", err.message);
  });
});

function handleLeave(playerID) {
  const player = players[playerID];
  if (!player) return;
  const lobbyID = player.lobbyID;
  if (lobbyID && lobbies[lobbyID]) {
    const lobby = lobbies[lobbyID];
    lobby.members.delete(playerID);
    broadcast(lobby, null, { type: "member_left", playerID });
    if (lobby.hostID === playerID || lobby.members.size === 0)
      delete lobbies[lobbyID];
    else if (lobby.hostID === playerID) {
      lobby.hostID = [...lobby.members.keys()][0];
      broadcast(lobby, null, { type: "host_changed", newHostID: lobby.hostID });
    }
  }
  delete players[playerID];
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(lobby, excludeID, msg) {
  for (const [id, ws] of lobby.members) {
    if (id !== excludeID) send(ws, msg);
  }
}
