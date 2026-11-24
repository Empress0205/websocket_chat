// The log-in screen (Phase 4). Accounts are created by an admin; there is
// no sign-up. After logging in, the server gives us a token that we keep in
// sessionStorage (this tab only, until it closes), so a reload logs us straight
// back in without typing the password again (see connection.js).

import { sendJSON, isOpen } from "./connection.js";

const loginScreen = document.getElementById("login");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const loginSubmit = document.getElementById("login-submit");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");

export function showLogin(error = "") {
  loginScreen.classList.remove("hidden");
  loginError.textContent = error;
  loginSubmit.disabled = !isOpen();
  usernameInput.focus();
}

export function hideLogin() {
  loginScreen.classList.add("hidden");
  passwordInput.value = "";
}

loginForm.onsubmit = (e) => {
  e.preventDefault(); // stop the browser reloading the page like a normal form
  loginError.textContent = "";
  loginSubmit.disabled = true;
  sendJSON({ type: "login", username: usernameInput.value.trim(), password: passwordInput.value });
};

document.getElementById("logout").onclick = () => sendJSON({ type: "logout" });
