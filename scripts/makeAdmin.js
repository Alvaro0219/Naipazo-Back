// Uso: npm run make-admin -- <nombreDeUsuario> [--revoke]
// Da (o quita, con --revoke) el rol de administrador a un usuario ya registrado.
import mongoose from 'mongoose';
import { connectDb } from '../src/config/db.js';
import { User } from '../src/models/User.js';

const [username, flag] = process.argv.slice(2);
if (!username) {
  console.error('Uso: npm run make-admin -- <nombreDeUsuario> [--revoke]');
  process.exit(1);
}

const role = flag === '--revoke' ? 'player' : 'admin';
await connectDb();
const user = await User.findOneAndUpdate(
  { usernameLower: username.trim().toLowerCase() },
  { role, $inc: { tokenVersion: 1 } }, // obliga a volver a iniciar sesión para que el token tenga el rol nuevo
  { new: true }
);
await mongoose.disconnect();

if (!user) {
  console.error(`No existe el usuario "${username}"`);
  process.exit(1);
}
console.log(`${user.username} ahora tiene rol "${user.role}". Tiene que volver a iniciar sesión.`);
