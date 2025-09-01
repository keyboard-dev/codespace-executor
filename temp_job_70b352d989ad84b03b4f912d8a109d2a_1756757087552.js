
(async () => {
    try {
        
console.log('🔄 Starting long-running test job...');

async function simulateLongRunningOperation() {
    console.log('⏳ Simulating API call (like fal.subscribe)...');
    
    // Simulate a 10-second API call
    await new Promise(resolve => {
        let progress = 0;
        const interval = setInterval(() => {
            progress += 20;
            console.log(`📊 Progress: ${progress}%`);
            
            if (progress >= 100) {
                clearInterval(interval);
                resolve();
            }
        }, 2000); // Update every 2 seconds
    });
    
    console.log('🎉 Long-running operation completed!');
    return { success: true, result: 'Generated image URL: https://example.com/image.png' };
}

// This should run until completion without premature exit
simulateLongRunningOperation().then(result => {
    console.log('✅ Final result:', JSON.stringify(result, null, 2));
    console.log('🏁 Job should complete naturally here');
}).catch(error => {
    console.error('❌ Error:', error.message);
    throw error;
});

        
        // Long-running job - let async operations complete naturally
        console.log('🔄 Long-running job mode: waiting for natural completion...');
        // No forced exit - let the code finish when it's done
        
        // Exit gracefully when code completes naturally
        console.log('✅ Job completed successfully');
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Job execution error:', error.message);
        console.error('❌ Error type:', error.constructor.name);
        console.error('❌ Stack trace:', error.stack);
        process.exit(1);
    }
})().catch(error => {
    console.error('❌ Promise rejection:', error.message);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Promise Rejection:', reason);
    process.exit(1);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error.message);
    process.exit(1);
});
