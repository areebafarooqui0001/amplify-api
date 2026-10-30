import { z } from 'zod';

export const registerSchema = z.object({
  email: z.email('Enter a valid email address').max(254),
  name: z.string().trim().min(1, 'Enter your name').max(80),
  // bcrypt only uses the first 72 bytes, so longer passwords are rejected instead of silently truncated
  password: z.string().min(8, 'Use at least 8 characters').max(72, 'Use at most 72 characters')
});

export const loginSchema = z.object({
  email: z.email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password').max(72)
});

export const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200) });
