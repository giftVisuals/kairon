// firebase.js
// Firebase initialization, Authentication, and Firestore exports.
// This file is loaded directly by the browser as an ES module (see index.html)
// via the Firebase CDN — no build step or npm install required on the client.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  OAuthProvider,
  signInWithPopup,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCbQhOaiW1BuJfESAfXkHdZzaAb1yg78sU",
  authDomain: "kairon-5f5ef.firebaseapp.com",
  projectId: "kairon-5f5ef",
  storageBucket: "kairon-5f5ef.firebasestorage.app",
  messagingSenderId: "985378760218",
  appId: "1:985378760218:web:c8a0480c3b9f285769d3a3",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();
const appleProvider = new OAuthProvider("apple.com");

function signInWithGoogle() {
  return signInWithPopup(auth, googleProvider);
}

function signInWithApple() {
  return signInWithPopup(auth, appleProvider);
}

function updateUserProfile(updates) {
  if (!auth.currentUser) return Promise.reject(new Error("Not signed in"));
  return updateProfile(auth.currentUser, updates);
}

function signUpWithEmail(email, password, displayName) {
  return createUserWithEmailAndPassword(auth, email, password).then((cred) => {
    if (displayName) {
      return updateProfile(cred.user, { displayName }).then(() => cred);
    }
    return cred;
  });
}

function signInWithEmail(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

function resetPassword(email) {
  return sendPasswordResetEmail(auth, email);
}

function logout() {
  return signOut(auth);
}

export {
  app,
  auth,
  db,
  signInWithGoogle,
  signInWithApple,
  signUpWithEmail,
  signInWithEmail,
  resetPassword,
  logout,
  onAuthStateChanged,
  updateUserProfile,
};
