const express = require('express');
const { exec } = require('child_process');

const router = express.Router();

router.get('/', (req, res) => {
    res.send('Hello World');
});

router.post('/execute', (req, res) => {
    console.log("req.body: ", req.body);
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

module.exports = router;