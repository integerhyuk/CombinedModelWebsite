const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));

function getMostFrequentEmotion(emotions) {
    const emotionCounts = {};
    emotions.forEach(emotion => {
        if (emotion in emotionCounts) {
            emotionCounts[emotion]++;
        } else {
            emotionCounts[emotion] = 1;
        }
    });

    let maxCount = 0;
    let mostFrequentEmotion = '';
    for (const emotion in emotionCounts) {
        if (emotionCounts[emotion] > maxCount) {
            maxCount = emotionCounts[emotion];
            mostFrequentEmotion = emotion;
        }
    }

    return mostFrequentEmotion;
}

app.post('/upload', upload.fields([{ name: 'videoFile', maxCount: 1 }, { name: 'csvFile', maxCount: 1 }, { name: 'eegFile', maxCount: 1 }]), async (req, res) => {
    const videoPath = req.files.videoFile[0].path;
    let audioPath = 'audio.wav';

    if (!fs.existsSync('uploads')) {
        fs.mkdirSync('uploads');
    }

    ffmpeg(videoPath)
        .output(audioPath)
        .on('end', async () => {
            console.log('Video-to-audio conversion completed.');

            const form = new FormData();
            form.append('file', fs.createReadStream(audioPath), {
                filename: 'audio.wav',
                contentType: 'audio/wav',
            });

            try {
                const transcribeRes = await axios.post('http://localhost:8000/transcribe/', form, {
                    headers: form.getHeaders(),
                });

                console.log('Transcribe response:', transcribeRes.data);

                const transcribeResult = transcribeRes.data.chunks.map(chunk => ({
                    timestamp: chunk.timestamp,
                    text: chunk.text
                }));

                const emotionResult = transcribeRes.data.seperated_audio.map(result => ({
                    text: result.text,
                    emotion: result.emotion
                }));

                if (transcribeResult.length === 0) {
                    res.status(400).json({ error: 'No transcribe results available.' });
                    return;
                }

                const chunksJson = JSON.stringify({ chunks: transcribeResult });

                const form2 = new FormData();
                form2.append('file', fs.createReadStream(videoPath), {
                    filename: 'video.mp4',
                    contentType: 'video/mp4',
                });
                form2.append('chunks_json', chunksJson);

                try {
                    const recognizeRes = await axios.post('http://localhost:8001/recognize_video/', form2, {
                        headers: form2.getHeaders(),
                    });

                    const recognizeResult = recognizeRes.data.result.map(result => ({
                        text: result.text,
                        emotion: result.emotion
                    }));

                    const form3 = new FormData();
                    form3.append('file', fs.createReadStream(req.files.csvFile[0].path));
                    form3.append('chunks_json', chunksJson);

                    try {
                        const analyzeRes = await axios.post('http://localhost:8002/analyze_sensors/', form3, {
                            headers: form3.getHeaders(),
                        });

                        const analyzeResult = analyzeRes.data.result.map(result => ({
                            emotion: result.emotion
                        }));

                        const form4 = new FormData();
                        form4.append('file', fs.createReadStream(req.files.eegFile[0].path));
                        form4.append('chunks_json', chunksJson);

                        try {
                            const eegRes = await axios.post('http://localhost:8003/EEG', form4, {
                                headers: form4.getHeaders(),
                            });

                            const eegResult = eegRes.data.map(result => ({
                                emotion: result.emotion
                            }));

                            const transcribeEmotions = emotionResult.map(result => {
                                const emotionProbabilities = result.emotion;
                                let maxEmotion = '';
                                let maxProbability = 0;
                                for (const emotion in emotionProbabilities) {
                                    if (emotionProbabilities[emotion] > maxProbability) {
                                        maxEmotion = emotion;
                                        maxProbability = emotionProbabilities[emotion];
                                    }
                                }
                                return maxEmotion;
                            });
                            const recognizeEmotions = recognizeResult.map(result => {
                                const emotionProbabilities = result.emotion;
                                let maxEmotion = '';
                                let maxProbability = 0;
                                for (const emotion in emotionProbabilities) {
                                    if (emotionProbabilities[emotion] > maxProbability) {
                                        maxEmotion = emotion;
                                        maxProbability = emotionProbabilities[emotion];
                                    }
                                }
                                return maxEmotion;
                            });
                            const analyzeEmotions = analyzeResult.map(result => result.emotion);
                            const eegEmotions = eegResult.map(result => result.emotion);

                            const overallEmotions = {
                                transcribe: getMostFrequentEmotion(transcribeEmotions),
                                recognize: getMostFrequentEmotion(recognizeEmotions),
                                analyze: getMostFrequentEmotion(analyzeEmotions),
                                eeg: getMostFrequentEmotion(eegEmotions)
                            };

                            res.json({ transcribeResult, emotionResult, recognizeResult, analyzeResult, eegResult, overallEmotions });
                        } catch (error) {
                            console.error(`Error when making a request to /EEG: ${error}`);
                            res.status(500).json({ error: 'An error occurred when processing the EEG data.' });
                        }
                    } catch (error) {
                        console.error(`Error when making a request to /analyze_sensors/: ${error}`);
                        res.status(500).json({ error: 'An error occurred when processing the sensor data.' });
                    }
                } catch (error) {
                    console.error(`Error when making a request to /recognize_video/: ${error}`);
                    if (error.response && error.response.status === 500) {
                        res.status(500).json({ error: 'An internal server error occurred in the /recognize_video/ endpoint.' });
                    } else {
                        res.status(500).json({ error: 'An error occurred when processing the video data.' });
                    }
                }
            } catch (error) {
                console.error(`Error when making a request to /transcribe/: ${error}`);
                res.status(500).json({ error: 'An error occurred when processing the audio data.' });
            }
        })
        .on('error', (err) => {
            console.error('Error during video-to-audio conversion:', err);
            res.status(500).json({ error: 'An error occurred during video-to-audio conversion.' });
        })
        .run();
});

app.listen(3000, () => console.log('Server started on port 3000'));