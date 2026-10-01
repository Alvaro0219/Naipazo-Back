import mongoose from 'mongoose';
import { env } from './env.js';

export async function connectDb(url = env.mongoUrl) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(url, { autoIndex: true });
}
