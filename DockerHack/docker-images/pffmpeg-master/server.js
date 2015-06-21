var ffmpeg		=	require('fluent-ffmpeg'),
    fs          =   require('fs'),
	rest		=	require('restler'),
	uuid		=	require('node-uuid'),
	url			=	require('url'),
	busboy		=	require('connect-busboy'),

    // Master stuff
    masterId			=	(new Date().getTime()).toString(16),
    masterworkspaceDir	=	'/home/ubuntu/df/master/' + masterId,
    taskId				=	null, // The task that runs this master. It's the name of the converted file

    // Express
    express			=	require('express'),
    app				=	express(),
    expressServer 	=	app.listen(8080),

    // Host mapping
    hosts			=	[],

    //
    rancherApiProjectEndpoint,
    dcpMasterApiEndpoint,
    videoFile,
    videoExt
;

function usage()
{
	// docker build -t ipernet/pffmpeg-master .

	// # wget -qO- https://get.docker.com/ | sh
	// # scp -r -i ~/.ssh/DockerHackaton.pem ~/Documents/DockerHack ubuntu@52.8.38.209:/home/ubuntu

	// # mkdir /home/ubuntu/df && mkdir /home/ubuntu/df/master/ && mkdir /home/ubuntu/df/input (master host)
	// # docker run -d --restart=always -p 8080:8080 rancher/server (master host)
	// # apt-get install nodejs npm && ln -s /usr/bin/nodejs /usr/bin/node
	// # cd /home/ubuntu/ui && npm install
	// # node server.js http://172.31.1.39:8080/v1/projects/1e1

	// Datastore container (for chunks)

	// docker create -v /home/ubuntu/df/:/home/ubuntu/df/ --name pffmpeg-datastore debian:jessie /bin/true
	// docker run --rm -p 8888:8080 --volumes-from pffmpeg-datastore ipernet/pffmpeg-master <RANCHER_API_PROJECT_ENDPOINT> <INPUT_FILE_ON_SHARED_VOLUME> <NUMBER_OF_HOSTS_TO_USE>

	// docker run --rm -p 8888:8080 --volumes-from pffmpeg-datastore ipernet/pffmpeg-master http://172.31.5.25:8080/v1/projects/1a5 /home/ubuntu/df/input/sintel_trailer-1080p.mp4 2
}

//--------------------------------------------------------------------------------------->

app.use(busboy());
app.use('/chunks/' + masterId, express.static(masterworkspaceDir));

// Validate inputs
try
{
    if(process.argv.length !== 6)
    {
		console.log(process.argv);
		throw {msg: 'Invalid arguments.'};
	}

	// Rancher host?
	var rancherUrl	=	url.parse(process.argv[2]);

	if( ! rancherUrl)
		throw {msg: 'Invalid Rancher API endpoint'};

	// TODO: to check as uuuid
	taskId	=	process.argv[3];

	// Input file?
    //if( ! fs.lstatSync(process.argv[3]).isFile())
    //    throw {msg: 'File not found: ' + process.argv[3]};

	var inputVideoUrl	=	url.parse(process.argv[4]);

	if( ! inputVideoUrl)
		throw {msg: 'Invalid video URL'};

	videoExt			=	process.argv[4].split('.').pop();

	if( ! videoExt)
		throw {msg: 'Unknown video extension'};

	videoFile					=	masterworkspaceDir + '/input.' + videoExt;
	rancherApiProjectEndpoint	=	process.argv[2],
	dcpMasterApiEndpoint		=	rancherUrl.protocol + '//' + rancherUrl.hostname + ':8888';

    var chunks  	=   parseInt(process.argv[5], 10);

	// Limited nb of hosts (=chunks)?
    if(isNaN(chunks))
        throw {msg: 'Invalid number of chunks'};

	// Master temp work dir?
    fs.mkdirSync(masterworkspaceDir);

    if( ! fs.lstatSync(masterworkspaceDir).isDirectory())
		throw {msg: 'Can\'t create master workspace dir'};

	Download(url.format(inputVideoUrl), videoFile, function(){ start() });
}
catch(e)
{
    console.log(e.msg);

    process.exit(1);
}

//--------------------------------------------------------------------------------------->

// API (workers), modularization for later
function validateWorker(token)
{
	var found = false;

	hosts.forEach(function(host, index)
	{
		if(host.token === token)
			found	=	true;
	});

	return found;
}

// API: GET Download link for worker chunk
app.get('/api/chunk', function(req, res)
{
	var host, hostIndex;

	try
	{
		if( ! req.query.token || ! validateWorker(req.query.token))
			throw {msg: 'Invalid token.'};

		// Check token and match if with actual chunk (to improve...)
		hosts.forEach(function(host, index)
		{
			if(host.token === req.query.token)
			{
				host		=	host.rancherId;
				hostIndex	=	index;
			}
		});
	}
	catch(e)
	{
		console.log(e.msg);

		res.status(400);
		res.json('error', { error: e.msg });
		return;
	}

	// return chunk URL for given worker
	res.json({ src: '/chunks/' + masterId + '/chunk' + hostIndex + '.' + videoExt})
});

// API: POST Upload link for converted chunk
app.post('/api/chunk', function(req, res)
{
	try
	{
		if( ! req.query.token || ! validateWorker(req.query.token))
			throw {msg: 'Invalid token.'};
	}
	catch(e)
	{
		console.log(e.msg);

		res.status(400);
		res.json('error', { error: e.msg });
		return;
	}


	var fstream;

    req.pipe(req.busboy);

    req.busboy.on('file', function(fieldname, file, filename)
    {
        // console.log('Receiving ', fieldname, file, filename);

        fstream = fs.createWriteStream(masterworkspaceDir + '/chunk' + req.query.token + '.264');

        file.pipe(fstream);

        fstream.on('close', function()
        {
			console.log('Worker ' + req.query.token + ' has completed its task!' + "\n");

			var all_done	=	true;

			hosts.forEach(function(host, index)
			{
				if(host.token === req.query.token)
					hosts[index].done	=	true;

				if( ! hosts[index].done)
					all_done	=	false;
			});

			if(all_done)
			{
				console.log('Job completed on all workers!' + "\n");

				merge();
			}
        });
    });
});


//--------------------------------------------------------------------------------------->

// APP Start: Get availablr hosts from the tool Rancher API instance
function start()
{
	rest.get(rancherApiProjectEndpoint + '/hosts', {headers: {'Accept': 'application/json'}}).on('complete', function(res)
	{
		if(res instanceof Error)
		{
			console.log('Error:', res.message);
		}
		else
		{
			// How many hosts?
			//console.log('RANCHER_API: ', res);

			for(var i = 0; i < res.data.length; i++)
				hosts.push({rancherId: res.data[i].id, token: uuid.v4(), done: false});

			split();
		}
	});
}

//--------------------------------------------------------------------------------------->

// FFMPEG helpers
function split()
{
	// FFMPEG splitter (master)
	ffmpeg.ffprobe(videoFile, function(err, metadata)
	{
		if(err || ! ( metadata.streams.length && metadata.streams[0].duration))
		{
			console.log("FFProbe: Can't probe input file");

			process.exit(1);
		}

		var duration    =   parseInt(metadata.streams[0].duration, 10),
			segment_t   =   Math.ceil(duration / chunks);

		console.log('Splitting ' + videoFile + ' (' + duration + ' sec.) in segments of ' + segment_t + ' sec. each');

		ffmpeg(videoFile).noAudio().videoCodec('copy').outputOptions([
			'-dn',
			'-reset_timestamps 1',
			'-segment_time ' + segment_t,
			'-map 0'
		])
		.format('segment')
		.on('progress', function(progress)
		{
			console.log('Splitting processing: ' + progress.percent + '% done');
		})
		.on('error', function(err)
		{
			console.log('An error occurred: ' + err.message);

			process.exit(1);
		})
		.on('end', function()
		{
			console.log('Splitting finished (master dir:' + masterworkspaceDir + ')!' + "\n");

			// console.log(hosts);

			// For each host available/selected, start a worker
			hosts.forEach(function(host, index)
			{
				var rancherData = {
					count: 1,
					imageUuid: 'docker:ipernet/pffmpeg-worker',
					networkIds: [],
					ports: [],
					requestedHostId: host.rancherId,
					startOnCreate: true,
					command: [dcpMasterApiEndpoint, host.token],
					publishAllPorts:false,
					privileged:false,
					capAdd:[], capDrop:[],
					dns:[], dnsSearch:[],
					stdinOpen:false,
					tty:false,
					entryPoint:["/nodejs/bin/npm", "start"],
					restartPolicy:null,
					devices:[],
					healthCheck:null,
					securityOpt:[],
					logConfig:null,
					extraHosts:[],
					readOnly:false,
					build:null,
					networkMode:"managed",
					dataVolumes:[], dataVolumesFrom:[]
				};

				rest.postJson(rancherApiProjectEndpoint + '/containers', rancherData, {headers: {'Accept': 'application/json', 'Content-Type': 'application/json'}}).on('complete', function(res)
				{
					if(res instanceof Error)
					{
						console.log('Error:', res.message);
					}
					else
					{
						console.log('=> Running Rancher worker "' + host.token + '" on host "' + host.rancherId + '"');
						// console.log(res);
					}
				});
			});

			console.log("\n");

			//socket.emit('done', { message: 'Done for "' + JSON.stringify(data) + '"'  });
		})
		.save(masterworkspaceDir + '/chunk%d.' + videoExt);
	});
};

function merge()
{
	var cmd	=	'cat ';

	hosts.forEach(function(host, index)
	{
		console.log('=> Adding input ' + masterworkspaceDir + '/chunk' + host.token + '.264');

		cmd += masterworkspaceDir + '/chunk' + host.token + '.264 ';
	});

	cmd	+=	'> ' + masterworkspaceDir + '/out.264';

	// ahaha (it's raw streams, it's OK!')
	require('child_process').exec(cmd, function(error, stdout, stderr)
	{
		box();
	});
}

function box()
{
	// FFMPEG boxing
	ffmpeg(masterworkspaceDir + '/out.264').noAudio().videoCodec('copy').outputOptions([

	])
	.format('mp4')
	.on('error', function(err)
	{
		console.log('An error occurred: ' + err.message);
	})
	.on('end', function()
	{
		console.log('Box processing done, output ready at ' + masterworkspaceDir + '/../' + taskId + '.mp4');

		process.exit(0);
	})
	.save(masterworkspaceDir + '/../' + taskId + '.mp4');
}

function Download(url, to, cb)
{
	console.log('Downloading ' + url + '...');

	// Download it
	var file	= 	fs.createWriteStream(to);

	var request =	require('http').get(url, function(response)
	{
		response.pipe(file);

		file.on('finish', function()
		{
			file.close(function()
			{
				console.log('Download finished.');

				cb();
			});
		});
	});
}
