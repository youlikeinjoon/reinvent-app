// Firebase 콘솔 → 프로젝트 설정 → 내 앱(웹)의 설정값.
// 공개되어도 되는 식별값이며, 데이터 보호는 로그인(보기 비밀번호)과 Firestore 보안 규칙이 맡습니다.
export const firebaseConfig = {
  apiKey: 'AIzaSyAKtd3bUJwMipCtdQS3tkRv5hI3iG7xWc0',
  authDomain: 'aws-reinvent-2026.firebaseapp.com',
  projectId: 'aws-reinvent-2026',
  storageBucket: 'aws-reinvent-2026.firebasestorage.app',
  messagingSenderId: '507505532394',
  appId: '1:507505532394:web:526e3f0c96dce6428b6693',
};

// 보기용 공용 계정. 앱에서 입력한 비밀번호 앞에 'reinvent-'를 붙여 이 계정으로 로그인합니다.
export const VIEWER_EMAIL = 'viewer@example.com';
export const viewerPassword = pin => `reinvent-${pin}`;

// 로컬 테스트용 에뮬레이터 연결(배포본에서는 null).
export const emulator = null;
