const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const HOST_PASSWORD = "1234";

// 서버 메모리 저장소
let hostSocketId = null;
let registeredUsers = {}; // { 닉네임: 비밀번호 }
let participants = []; // { id, name, isHost }
let waitingUsers = []; // { id, nick, pw, type: 'signup' | 'login' }

function broadcastRoomState() {
  io.emit("roomState", {
    hasHost: Boolean(hostSocketId),
    participants,
  });
  if (hostSocketId) {
    io.to(hostSocketId).emit("waitingList", waitingUsers);
  }
}

io.on("connection", (socket) => {
  // 1. 방장 입장
  socket.on("hostEnter", ({ password }) => {
    if (password !== HOST_PASSWORD) {
      socket.emit("errorMsg", "방장 암호가 틀렸습니다. (암호: 1234)");
      return;
    }
    if (hostSocketId && hostSocketId !== socket.id) {
      socket.emit("errorMsg", "이미 방장이 접속해 있습니다.");
      return;
    }

    hostSocketId = socket.id;
    participants = participants.filter((p) => p.id !== socket.id);
    participants.unshift({ id: socket.id, name: "주원(방장)", isHost: true });

    socket.emit("enterSuccess", { isHost: true, name: "주원(방장)" });
    io.emit("systemMsg", "방장이 입장하여 채팅방이 열렸습니다.");
    broadcastRoomState();
  });

  // 2. 회원가입 신청
  socket.on("requestSignup", ({ nick, pw }) => {
    const cleanNick = (nick || "").trim();
    const cleanPw = (pw || "").trim();

    if (!cleanNick || !cleanPw) {
      socket.emit("errorMsg", "닉네임과 비밀번호를 모두 입력해주세요.");
      return;
    }
    if (registeredUsers[cleanNick] || cleanNick === "주원(방장)") {
      socket.emit("errorMsg", "이미 사용 중인 닉네임입니다.");
      return;
    }
    if (!hostSocketId) {
      socket.emit("errorMsg", "방장이 먼저 들어와야 신청할 수 있어요.");
      return;
    }

    waitingUsers = waitingUsers.filter((u) => u.id !== socket.id);
    waitingUsers.push({ id: socket.id, nick: cleanNick, pw: cleanPw, type: "signup" });

    socket.emit("waitingStarted", {
      msg: `'${cleanNick}' 님의 회원가입 및 입장을 방장에게 요청했어요.`,
    });
    broadcastRoomState();
  });

  // 3. 로그인(입장) 신청
  socket.on("requestLogin", ({ nick, pw }) => {
    const cleanNick = (nick || "").trim();
    const cleanPw = (pw || "").trim();

    if (!cleanNick || !cleanPw) {
      socket.emit("errorMsg", "닉네임과 비밀번호를 모두 입력해주세요.");
      return;
    }
    if (registeredUsers[cleanNick] !== cleanPw) {
      socket.emit("errorMsg", "닉네임 또는 비밀번호가 일치하지 않습니다. (먼저 회원가입을 진행해주세요)");
      return;
    }
    if (!hostSocketId) {
      socket.emit("errorMsg", "방장이 먼저 들어와야 입장할 수 있어요.");
      return;
    }
    if (participants.some((p) => p.name === cleanNick)) {
      socket.emit("errorMsg", "이미 채팅방에 접속 중인 닉네임입니다.");
      return;
    }

    waitingUsers = waitingUsers.filter((u) => u.id !== socket.id);
    waitingUsers.push({ id: socket.id, nick: cleanNick, pw: cleanPw, type: "login" });

    socket.emit("waitingStarted", {
      msg: `'${cleanNick}' 님의 입장 요청을 방장에게 보냈어요.`,
    });
    broadcastRoomState();
  });

  // 4. 방장: 수락
  socket.on("approveUser", (targetId) => {
    if (socket.id !== hostSocketId) return;
    const idx = waitingUsers.findIndex((u) => u.id === targetId);
    if (idx === -1) return;

    const user = waitingUsers.splice(idx, 1)[0];
    if (user.type === "signup") {
      registeredUsers[user.nick] = user.pw;
    }

    participants.push({ id: user.id, name: user.nick, isHost: false });
    io.to(user.id).emit("enterSuccess", { isHost: false, name: user.nick });
    io.emit(
      "systemMsg",
      user.type === "signup"
        ? `${user.nick}님이 회원가입 승인 후 입장했습니다.`
        : `${user.nick}님이 입장했습니다.`
    );
    broadcastRoomState();
  });

  // 5. 방장: 거절
  socket.on("rejectUser", (targetId) => {
    if (socket.id !== hostSocketId) return;
    const idx = waitingUsers.findIndex((u) => u.id === targetId);
    if (idx === -1) return;

    const user = waitingUsers.splice(idx, 1)[0];
    io.to(user.id).emit("rejected", `${user.nick}님의 요청이 방장에 의해 거절되었습니다.`);
    broadcastRoomState();
  });

  // 6. 방장: 손님 내보내기
  socket.on("kickUser", (targetId) => {
    if (socket.id !== hostSocketId || targetId === hostSocketId) return;
    const target = participants.find((p) => p.id === targetId);
    if (!target) return;

    participants = participants.filter((p) => p.id !== targetId);
    io.to(targetId).emit("kicked", "방장에 의해 채팅방에서 내보내졌습니다.");
    io.emit("systemMsg", `방장이 ${target.name}님을 내보냈습니다.`);
    broadcastRoomState();
  });

  // 7. 채팅 메시지 전송
  socket.on("sendMessage", (text) => {
    const sender = participants.find((p) => p.id === socket.id);
    const cleanText = (text || "").trim();
    if (!sender || !cleanText) return;

    io.emit("chatMessage", {
      senderId: socket.id,
      senderName: sender.name,
      text: cleanText,
    });
  });

  // 8. 방장: 방 닫기
  socket.on("closeRoom", () => {
    if (socket.id !== hostSocketId) return;
    io.emit("roomClosed", "방장이 채팅방을 닫았습니다.");
    hostSocketId = null;
    participants = [];
    waitingUsers = [];
  });

  // 9. 연결 끊김 처리
  socket.on("disconnect", () => {
    waitingUsers = waitingUsers.filter((u) => u.id !== socket.id);

    if (socket.id === hostSocketId) {
      io.emit("roomClosed", "방장이 나가서 채팅방이 닫혔습니다.");
      hostSocketId = null;
      participants = [];
      waitingUsers = [];
      return;
    }

    const leftUser = participants.find((p) => p.id === socket.id);
    if (leftUser) {
      participants = participants.filter((p) => p.id !== socket.id);
      io.emit("systemMsg", `${leftUser.name}님이 나갔습니다.`);
      broadcastRoomState();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
