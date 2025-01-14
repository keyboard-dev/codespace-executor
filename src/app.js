
const express = require('express');
const { exec } = require('child_process');

const app = express();
const router = express.Router();

// Add this line before your routes
app.use(express.json());

router.get('/', (req, res) => {
    res.send('Hello World');
});

router.post('/execute', (req, res) => {
    const { command } = req.body;
    console.log("command: ", command);
    if (!command) {
        return res.status(400).json({ error: 'Command is required' });
    }

    exec(command, (error, stdout, stderr) => {
        if (error) {
            return res.status(500).json({ error: error.message });
        }
        
        res.json({
            output: stdout,
            error: stderr
        });
    });
});

app.use('/', router);

module.exports = app;