var httpServer	=	require('http').createServer().listen(80),
	ffmpeg		=	require('fluent-ffmpeg'),
    fs          =   require('fs'),
	rest		=	require('restler'),
	url			=	require('url'),

    // Client stuff
    chunkFile	=	'/home/input',
    outFile		=	'/home/output.264',
    dcpEndpoint,
	token
;

function usage()
{
	// docker build -t ipernet/ffmpeg-worker .
	// docker run --rm ipernet/ffmpeg-worker <DCP_API_ENDPOINT> <TOKEN>
	// docker run --rm ipernet/ffmpeg-worker http://172.31.5.25:8888/ <TOKEN>
}

//--------------------------------------------------------------------------------------->


// Validate inputs
try
{
    if(process.argv.length !== 4)
        throw {msg: 'Invalid arguments.'};

	// Master API endpoint?
	if( ! url.parse(process.argv[2]))
		throw {msg: 'Invalid API endpoint'};

	// Client token? TODO: format check
	if( ! process.argv[3])
		throw {msg: 'Where is my token?'};

	dcpEndpoint	=	process.argv[2];
	token		=	process.argv[3];
}
catch(e)
{
    console.log(e.msg);

    process.exit(1);
}

//--------------------------------------------------------------------------------------->

// get my chunk
console.log('Getting chunk: ' + dcpEndpoint + '/api/chunk?token='  + token);

rest.get(dcpEndpoint + '/api/chunk?token='  + token, {headers: {'Accept': 'application/json'}}).on('complete', function(res)
{
	if(res instanceof Error)
	{
		console.log('Error:', res.message);
	}
	else
	{
		Download(dcpEndpoint + res.src, chunkFile); // from, to
	}
});

function Download(url, to)
{
	console.log('Downloading ' + url);

	// Download it
	var file	= 	fs.createWriteStream(to);

	var request =	require('http').get(url, function(response)
	{
		response.pipe(file);

		file.on('finish', function()
		{
			file.close(function()
			{
				Convert(chunkFile);
			});
		});
	});
}

function Convert(chunkFile)
{
	console.log('Converting ' + chunkFile);

	ffmpeg(chunkFile).noAudio().videoCodec('libx264').outputOptions([

	])
	.videoBitrate('1000k')
	.format('h264')
	.on('error', function(err)
	{
		console.log('An error occurred: ' + err.message);

		process.exit(1);
	})
	.on('progress', function(progress)
	{
		console.log('Processing: ' + progress.percent + '% done');
	})
	.on('end', function()
	{
		console.log('Processing finished');

		Upload(outFile);
	})
	.save(outFile);
}

function Upload(file)
{
	var fileStats		=	fs.statSync(file);
	var fileSizeInBytes =	fileStats['size'];

	console.log('Uploading ' + fileSizeInBytes + ' bytes');

	rest.post(dcpEndpoint + '/api/chunk?token='  + token, {
		multipart: true,
		data: {
			'file': rest.file(file, null, fileSizeInBytes, null, 'video/mp4')
		}
	}).on('complete', function(data)
	{
		process.exit(0);
	});
}
