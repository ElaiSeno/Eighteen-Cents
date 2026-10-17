document.addEventListener("DOMContentLoaded", () => {
// =====================================
// CREATE BACKGROUND
// =====================================

const background = document.createElement("div");
background.className = "background";

const totalCircles = 6;

for (let i = 0; i < totalCircles; i++) {

    const circle = document.createElement("div");
    circle.classList.add("circle");

    // Fixed: first 3 are circle1, last 3 are circle2
    const type = i < 3 ? "circle1" : "circle2";

    circle.classList.add(type);
    background.appendChild(circle);
}

document.body.appendChild(background);

    // =====================================
    // CREATE GLASS
    // =====================================

    const glass = document.createElement("div");
    glass.className = "glass-overlay";

    document.body.appendChild(glass);


    // =====================================
    // SETTINGS
    // =====================================

    const circles = document.querySelectorAll(".circle");

    const SIZE = Math.min(window.innerWidth, window.innerHeight) * 0.40;

    const circleData = [];


    // =====================================
    // CHECK SAME-TYPE COLLISION
    // =====================================

    function isSameType(a, b) {

        return (
            a.classList.contains("circle1") &&
            b.classList.contains("circle1")
        ) ||
        (
            a.classList.contains("circle2") &&
            b.classList.contains("circle2")
        );

    }


    // =====================================
    // CREATE POSITIONS
    // =====================================

    circles.forEach(circle => {

        let x = Math.random() * window.innerWidth - SIZE / 2;
        let y = Math.random() * window.innerHeight - SIZE / 2;

        let bestX = x;
        let bestY = y;

        let bestDistance = 0;

        // ONLY try 100 times
        for (let attempt = 0; attempt < 100; attempt++) {

            const testX =
                Math.random() * window.innerWidth - SIZE / 2;

            const testY =
                Math.random() * window.innerHeight - SIZE / 2;


            let closestDistance = Infinity;


            for (const other of circleData) {

                if (isSameType(circle, other.element)) {

                    const distance = Math.hypot(
                        testX - other.x,
                        testY - other.y
                    );

                    closestDistance =
                        Math.min(closestDistance, distance);

                }

            }


            // If there are no same-type circles yet
            if (closestDistance === Infinity) {
                bestX = testX;
                bestY = testY;
                break;
            }


            // Keep the position that has the most space
            if (closestDistance > bestDistance) {

                bestDistance = closestDistance;

                bestX = testX;
                bestY = testY;

            }


            // Perfect position found
            if (closestDistance >= SIZE) {

                bestX = testX;
                bestY = testY;

                break;

            }

        }


        // =================================
        // RANDOM MOVEMENT
        // =================================

        const angle =
            Math.random() * Math.PI * 2;

        // Very slow movement
        const speed =
            0.15 + Math.random() * 0.25;


        const dx =
            Math.cos(angle) * speed;

        const dy =
            Math.sin(angle) * speed;


        circleData.push({

            element: circle,

            x: bestX,
            y: bestY,

            dx: dx,
            dy: dy

        });

    });


    // =====================================
    // ANIMATION
    // =====================================

    function animate() {

        // ---------------------------------
        // MOVE CIRCLES
        // ---------------------------------

        circleData.forEach(circle => {

            circle.x += circle.dx;
            circle.y += circle.dy;


            // Bounce from left/right

            if (
                circle.x <= -SIZE / 2 ||
                circle.x >= window.innerWidth - SIZE / 2
            ) {

                circle.dx *= -1;

            }


            // Bounce from top/bottom

            if (
                circle.y <= -SIZE / 2 ||
                circle.y >= window.innerHeight - SIZE / 2
            ) {

                circle.dy *= -1;

            }

        });


        // ---------------------------------
        // SAME-TYPE COLLISIONS
        // ---------------------------------

        for (let i = 0; i < circleData.length; i++) {

            for (
                let j = i + 1;
                j < circleData.length;
                j++
            ) {

                const a = circleData[i];
                const b = circleData[j];


                // Different types can overlap
                if (!isSameType(a.element, b.element)) {
                    continue;
                }


                const distance = Math.hypot(
                    a.x - b.x,
                    a.y - b.y
                );


                if (distance < SIZE) {

                    // Prevent division by zero
                    if (distance === 0) {
                        a.x += 1;
                        b.x -= 1;
                        continue;
                    }


                    const angle = Math.atan2(
                        b.y - a.y,
                        b.x - a.x
                    );


                    const overlap =
                        SIZE - distance;


                    // Push circles apart

                    a.x -=
                        Math.cos(angle) *
                        overlap / 2;

                    a.y -=
                        Math.sin(angle) *
                        overlap / 2;


                    b.x +=
                        Math.cos(angle) *
                        overlap / 2;

                    b.y +=
                        Math.sin(angle) *
                        overlap / 2;


                    // Bounce

                    a.dx *= -1;
                    a.dy *= -1;

                    b.dx *= -1;
                    b.dy *= -1;

                }

            }

        }


        // ---------------------------------
        // APPLY POSITIONS
        // ---------------------------------

        circleData.forEach(circle => {

            circle.element.style.transform =
                `translate(${circle.x}px, ${circle.y}px)`;

        });


        requestAnimationFrame(animate);

    }


    animate();

});