

import { initializeApp } from 'firebase/app'
import {
  getAuth,
  GoogleAuthProvider,
} from 'firebase/auth'

const firebaseConfig = {
 apiKey: "AIzaSyBGPg9M_U_gDTAlda1SY1haoH9DZyW93RA",
  authDomain: "reachinbox-110d5.firebaseapp.com",
  projectId: "reachinbox-110d5",
  storageBucket: "reachinbox-110d5.firebasestorage.app",
  messagingSenderId: "963313130263",
  appId: "1:963313130263:web:f1b736845f5107a69f7552",
}

const app = initializeApp(firebaseConfig)

export const auth = getAuth(app)
export const googleProvider = new GoogleAuthProvider()





 