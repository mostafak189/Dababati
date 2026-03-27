// comments.js
const feed = document.getElementById("feed");
const composeInput = document.getElementById("compose-text");
const composeName = document.getElementById("compose-name");
const submitBtn = document.getElementById("submit-btn");

const PIN = "4721";

async function loadComments() {
  const res = await fetch("/comments");
  const comments = await res.json();
  renderComments(comments);
}

function renderComments(comments) {
  feed.innerHTML = "";
  if (comments.length === 0) {
    feed.innerHTML = `<div class="comment-empty pulse">// NO TRANSMISSIONS — BE THE FIRST //</div>`;
    return;
  }
  comments.forEach(c => {
    const div = document.createElement("div");
    div.classList.add("comment-card");
    div.innerHTML = `
      <div class="comment-top">
        <div class="comment-avatar">${c.name[0].toUpperCase()}</div>
        <div class="comment-name">${c.name}</div>
        <div class="comment-time">${new Date(c.timestamp).toLocaleTimeString()}</div>
      </div>
      <div class="comment-body">${c.body}</div>
      <div class="comment-actions">
        <button class="action-btn delete-btn">DELETE</button>
      </div>
    `;
    // Delete handler
    div.querySelector(".delete-btn").addEventListener("click", async () => {
      const pinInput = prompt("Enter PIN to delete this comment:");
      if (pinInput !== PIN) return alert("Incorrect PIN");
      await fetch(`/comments/${c.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: pinInput })
      });
      loadComments();
    });
    feed.appendChild(div);
  });
}

// Submit new comment
submitBtn.addEventListener("click", async () => {
  const name = composeName.value.trim();
  const body = composeInput.value.trim();
  if (!name || !body) return alert("Name and comment required");
  await fetch("/comments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, body })
  });
  composeInput.value = "";
  loadComments();
});

// Initial load
loadComments();
