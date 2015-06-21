var httpServer	=	require('http').createServer().listen(8081),
    fs          =   require('fs'),
	rest		=	require('restler'),
	url			=	require('url'),
	hbs			=	require('express-handlebars'),
	bodyParser	=	require('body-parser'),
	uuid		=	require('node-uuid'),

    // Express
    express			=	require('express'),
    app				=	express(),
    expressServer 	=	require('http').Server(app);
	io				=	require('socket.io')(expressServer);

    pendingTaskFile	=	__dirname + '/task.json'
;

expressServer.listen(80);

// Middlewares
app.engine('hbs', hbs({extname: 'hbs', defaultLayout: 'main.hbs'}));
app.set('view engine', 'hbs');

app.use('/videos' , express.static('/home/ubuntu/df/master/'));
app.use(express.static('public'));
app.use(bodyParser.urlencoded({
	extended: true
}));

function usage()
{
	//node server.js http://172.31.1.39:8080/v1/projects/1a5
	console.log('node server.js http://<Rancher IP>:<Rancher PORT>/v1/projects/<PROJECT ID>');
	process.exit(1);
}

try
{
	if(process.argv.length !== 3)
		throw {msg: 'Invalid arguments.'};

	// Rancher instance for video project
	var rancherApiProjectEndpoint	=	url.parse(process.argv[2]);

	if( ! rancherApiProjectEndpoint)
		throw {msg: 'Invalid Rancher API endpoint'};

	rancherApiProjectEndpoint	=	url.format(rancherApiProjectEndpoint);
}
catch(e)
{
	console.log(e.msg);
	process.exit(1);
}

app.get('/', function(req, res)
{
	res.render('index');
});

app.get('/start', function(req, res)
{
	res.render('project/start', {
		rancher_api_video: rancherApiProjectEndpoint
	});
});

app.get('/task', function(req, res)
{
	//TODO: check as uuuid
	if( ! req.query.id)
		return req.redirect('/');

	fs.readFile(__dirname + '/tasks/' + req.query.id + '.json', 'utf8', function(err, task)
	{
		if(err)
		{
			return req.redirect('/?err=' + err);
		}

		var task	=	Task.createFromFile(JSON.parse(task));

		res.render('project/show', {task: task});
	});
});

app.get('/join', function(req, res)
{
	rest.get(rancherApiProjectEndpoint + '/registrationtokens', {headers: {'Accept': 'application/json'}}).on('complete', function(ranchRes)
		{
			if(res instanceof Error)
			{
				console.log('Error:', res.message);
			}
			else
			{
				res.render('project/join', {command: ranchRes.data[0].command});
			}
		}
	);
});

app.get('/stats', function(req, res)
{
	res.render('project/stats');
});

app.post('/start', function(req, res)
{
	// Demo limit: Max 1 running/pending task

	try
	{
		// Url
		var videoUrl	=	url.parse(req.body.p_url);

		if( ! videoUrl)
			throw {msg: 'Invalid video URL'};

		// Min workers
		if(isNaN(req.body.p_workers))
			throw {msg: 'Invalid min workers'};

		if(isNaN(req.body.p_public))
			throw {msg: 'Invalid public workers'};
	}
	catch(e)
	{
		console.log(e.msg);
		return res.redirect('/');
	}

	var task		=	new Task(req.body.p_url, parseInt(req.body.p_workers, 10), parseInt(req.body.p_public, 10)),
		taskFile	=	__dirname + '/tasks/' + task.tId + '.json';

	task.save(function()
	{
		// TODO: multi concurrent tasks
		try
		{
			fs.unlinkSync(pendingTaskFile);
		}
		catch(e)
		{

		}

		require('child_process').exec('ln -s ' + taskFile + ' ' + pendingTaskFile, function(error, stdout, stderr)
		{
			return res.redirect('/task/?id=' + task.tId);
		});
	});
});

// Task object
var Task = function(srcUrl, nbWorkers, nbPublicWorkers)
{
	this.tId		=	uuid.v4()
	this.srcUrl		=	srcUrl;
	this.nbWorkers	=	nbWorkers;
	this.status		=	'pending';

	this.nbPublicWorkers	=	nbPublicWorkers;
};

Task.prototype.toString	=	function()
{
	return {
		tId: this.tId,
		srcUrl: this.srcUrl,
		nbWorkers: this.nbWorkers,
		nbPublicWorkers: this.nbPublicWorkers,

		status: this.status,
		startedAt: null,
		endedAt: null,
		result: null,
		usage: {
			cpu: null,
			mem: null
		}
	}
}

Task.createFromFile	=	function(taskData)
{
	var task		=	new Task();

	task.tId		=	taskData.tId,
	task.srcUrl		=	taskData.srcUrl,
	task.nbWorkers	=	taskData.nbWorkers,
	task.nbPublicWorkers	=	taskData.nbPublicWorkers,

	task.status	=	taskData.status,
	task.startedAt	=	null,
	task.endedAt	=	null,
	task.result	=	null,
	task.usage	=	{
		cpu: null,
		mem: null
	}

	return task;
}

Task.prototype.save	=	function(cb)
{
	var taskFile	=	__dirname + '/tasks/' + this.tId + '.json';

	fs.writeFile(taskFile, JSON.stringify(this.toString()), function(err)
	{
		if(err)
			return console.log(err);

		if(typeof cb === 'function')
			cb();
	});
}

var socket_global; //the ugliest, no time for undeeded task based logs for now

io.on('connection', function(socket)
{
	socket_global	=	socket;

	socket.emit('logs', { msg: 'Waiting...' });
});

// Check if pending tasks and start them if needed
setInterval(function()
{
	fs.readFile(pendingTaskFile, 'utf8', function(err, task)
	{
		if(err)
		{
			return;
			//return console.log(err);
		}

		var task	=	Task.createFromFile(JSON.parse(task));

		if( ! task)
			return console.log('Invalid JSON');

		// Rancher tool instance host requirement OK?
		rest.get(rancherApiProjectEndpoint + '/hosts', {headers: {'Accept': 'application/json'}}).on('complete', function(res)
		{
			if(res instanceof Error)
			{
				console.log('Error:', res.message);
			}
			else
			{
				// TODO: busyness, private/public workers...
				if(res.data.length >= task.nbWorkers)
				{
					console.log('Starting task...');

					// Don't rerun it.
					fs.unlinkSync(pendingTaskFile);

					// TODO: dynamic rancher instances => Dynamic ports
					var docker = require('child_process').spawn('docker',
						[
							'run', '--rm', '-p', '8888:8080', '--volumes-from', 'pffmpeg-datastore', 'ipernet/pffmpeg-master', rancherApiProjectEndpoint, task.tId, task.srcUrl, res.data.length
						]
					);

					docker.stdout.on('data', function(data)
					{
						console.log('[' + task.tId + '] ' + data);

						if(socket_global)
							socket_global.emit('logs', { msg: data.toString() });
					});

					docker.stderr.on('data', function(data)
					{
						console.log('[' + task.tId + ']' + ' stderr: ' + data);

						if(socket_global)
							socket_global.emit('logs', { msg: data.toString() });
					});

					docker.on('exit', function(code)
					{
						console.log('[' + task.tId + '] exited (' + code + ')');

						if(code == 0)
						{
							task.status	= 'completed';
							task.save();
						}

						if(socket_global)
							socket_global.emit('logs', { msg: 'Exited with code ' + code });
					});
				}
				else
					console.log('Not enough workers (' + res.data.length + ' / ' + task.nbWorkers + ')');
			}
		});
	});
}, 5000)
