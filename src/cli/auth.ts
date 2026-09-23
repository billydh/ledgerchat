import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { localPassword } from '../server/auth.js';

console.log('Username: ledgerchat');
console.log(`Password: ${localPassword(join(dirname(config.db.path), 'server-password'))}`);
