const name = process.env.MONGO_APP_DB || 'xiaomang';
db.getSiblingDB(name).createUser({
  user: process.env.MONGO_APP_USER,
  pwd: process.env.MONGO_APP_PASSWORD,
  roles: [{ role: 'readWrite', db: name }],
});
