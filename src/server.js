const express = require('express');
const routes = require('./routes/index');

const app = express();
app.use(express.json()); 
const PORT = process.env.PORT || 3000;

app.use('/', routes);

app.listen(PORT, () => {

});