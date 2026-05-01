export class DitheringShader {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'dithering-canvas';
    this.gl = this.canvas.getContext('webgl', { alpha: true, preserveDrawingBuffer: false });
    this.isActive = false;
    this.gpuTimeMs = 0;
    
    this.rIn = 35.0; 
    this.rOut = 45.0;
    
    if (!this.gl) {
      console.warn('WebGL not supported, will use CSS fallback.');
    } else {
      this.initWebGL();
    }
    
    window.addEventListener('resize', () => this.resize());
  }

  get isValid() {
    return !!this.gl;
  }

  resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    if (this.gl) {
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  initWebGL() {
    this.resize();
    this.canvas.style.position = 'fixed';
    this.canvas.style.top = '0';
    this.canvas.style.left = '0';
    this.canvas.style.width = '100vw';
    this.canvas.style.height = '100vh';
    this.canvas.style.pointerEvents = 'none';
    this.canvas.style.zIndex = '9998';
    // 移除 opacity = '0'，透明度由 shader 的 u_intensity 完全接管
    document.body.appendChild(this.canvas);

    const vsSource = `
      attribute vec2 a_position;
      varying vec2 v_uv;
      void main() {
        v_uv = a_position * 0.5 + 0.5;
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `;

    // 機率抖動演算法 (Dithering) p = (r_px - r_in) / (r_out - r_in)
    const fsSource = `
      precision highp float;
      varying vec2 v_uv;
      uniform vec2 u_center;
      uniform vec2 u_resolution;
      uniform float u_rIn;
      uniform float u_rOut;
      uniform float u_time;
      uniform float u_intensity;

      float rand(vec2 co){
        return fract(sin(dot(co.xy ,vec2(12.9898,78.233))) * 43758.5453);
      }

      void main() {
        vec2 px = v_uv * u_resolution;
        vec2 center = u_center * u_resolution;
        vec2 diff = px - center;
        // 恢復正圓形，確保 FOV 是從邊角開始遮蔽
        float distPx = length(diff);
        
        // Use the farthest corner distance from the gaze center so edge coverage
        // remains complete even when the center is near a screen boundary.
        float d1 = length(center - vec2(0.0, 0.0));
        float d2 = length(center - vec2(u_resolution.x, 0.0));
        float d3 = length(center - vec2(0.0, u_resolution.y));
        float d4 = length(center - vec2(u_resolution.x, u_resolution.y));
        float maxDistPx = max(max(d1, d2), max(d3, d4));
        float r_px = (distPx / max(maxDistPx, 1.0)) * 100.0;
        
        float p = clamp((r_px - u_rIn) / (u_rOut - u_rIn), 0.0, 1.0);
        // 使用固定的 uv 作為亂數種子，避免每幀更新產生電視雜訊般的劇烈閃爍
        float nr = rand(v_uv);
        
        if (nr < p) {
          // 灰黑色遮罩 - 結合 u_intensity 進行淡入淡出 (Premultiplied Alpha)
          vec4 maskColor = vec4(0.04 * u_intensity, 0.04 * u_intensity, 0.04 * u_intensity, 0.4 * u_intensity);
          
          float gridX = mod(px.x, 80.0);
          float gridY = mod(px.y, 80.0);
          // 深灰色近透明框線 - 結合 u_intensity
          if(gridX < 1.0 || gridY < 1.0) {
             maskColor = vec4(0.03 * u_intensity, 0.03 * u_intensity, 0.03 * u_intensity, 0.15 * u_intensity); 
          }
          
          gl_FragColor = maskColor;
        } else {
          gl_FragColor = vec4(0.0);
        }
      }
    `;

    const shaderProgram = this.createProgram(this.gl, vsSource, fsSource);
    this.programInfo = {
      program: shaderProgram,
      attribLocations: { position: this.gl.getAttribLocation(shaderProgram, 'a_position') },
      uniformLocations: {
        center: this.gl.getUniformLocation(shaderProgram, 'u_center'),
        resolution: this.gl.getUniformLocation(shaderProgram, 'u_resolution'),
        rIn: this.gl.getUniformLocation(shaderProgram, 'u_rIn'),
        rOut: this.gl.getUniformLocation(shaderProgram, 'u_rOut'),
        time: this.gl.getUniformLocation(shaderProgram, 'u_time'),
        intensity: this.gl.getUniformLocation(shaderProgram, 'u_intensity'),
      },
    };

    const positionBuffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
    const positions = [ -1.0, 1.0, 1.0, 1.0, -1.0, -1.0, 1.0, -1.0 ];
    this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(positions), this.gl.STATIC_DRAW);
    this.positionBuffer = positionBuffer;
  }

  createProgram(gl, vs, fs) {
    const vShader = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vShader, vs);
    gl.compileShader(vShader);
    
    const fShader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fShader, fs);
    gl.compileShader(fShader);
    
    const program = gl.createProgram();
    gl.attachShader(program, vShader);
    gl.attachShader(program, fShader);
    gl.linkProgram(program);
    return program;
  }

  render(mouseX, mouseY, rIn, rOut, intensity = 1.0) {
    if (!this.gl) return;
    
    // 如果強度歸零，清空畫布即可，節省 GPU
    if (intensity <= 0.01) {
      this.gl.clearColor(0.0, 0.0, 0.0, 0.0);
      this.gl.clear(this.gl.COLOR_BUFFER_BIT);
      return;
    }
    
    const start = performance.now();

    this.gl.clearColor(0.0, 0.0, 0.0, 0.0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);

    this.gl.useProgram(this.programInfo.program);

    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);
    this.gl.vertexAttribPointer(this.programInfo.attribLocations.position, 2, this.gl.FLOAT, false, 0, 0);
    this.gl.enableVertexAttribArray(this.programInfo.attribLocations.position);

    this.gl.uniform2f(this.programInfo.uniformLocations.center, mouseX / this.canvas.width, 1.0 - (mouseY / this.canvas.height));
    this.gl.uniform2f(this.programInfo.uniformLocations.resolution, this.canvas.width, this.canvas.height);
    this.gl.uniform1f(this.programInfo.uniformLocations.rIn, rIn);
    this.gl.uniform1f(this.programInfo.uniformLocations.rOut, rOut);
    this.gl.uniform1f(this.programInfo.uniformLocations.time, performance.now() / 1000.0);
    this.gl.uniform1f(this.programInfo.uniformLocations.intensity, intensity);

    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);

    const end = performance.now();
    this.gpuTimeMs = end - start; // 確保嚴格控制在毫秒級 (<3.53ms)
  }

  setActive(active) {
    this.isActive = active;
    // 透明度與漸變完全交由 RenderController 與 u_intensity 處理，不再強制設定 CSS opacity
  }
}
